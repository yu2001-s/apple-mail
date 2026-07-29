import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "@/types.js";
import {
  buildScheduledSendLaunchAgentPlist,
  ensureScheduledSendLaunchAgent,
  parseScheduledInstant,
  ScheduledSendManager,
} from "@/services/scheduledSendManager.js";

const tempDirs: string[] = [];

function tempPath(name = "scheduled-sends.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "apple-mail-schedules-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    draftId: "apple-draft:00000000-0000-4000-8000-000000000001",
    revision: "reviewed-revision",
    nativeId: "55902",
    from: "Tester <test@example.com>",
    to: ["to@example.com"],
    cc: [],
    bcc: [],
    subject: "Reviewed",
    body: "Exact reviewed body",
    visible: false,
    sourceKind: "mailbox",
    accountId: "account-1",
    accountName: "iCloud",
    mailboxName: "Drafts",
    messageId: "draft@example.com",
    hasAttachments: false,
    ...overrides,
  };
}

function fakeDraftManager(initialDrafts: Draft[]) {
  const byId = new Map(initialDrafts.map((item) => [item.draftId, item]));
  const sendDraft = vi.fn(async (draftId: string) => {
    const item = byId.get(draftId);
    return item ? { success: true, draft: item } : { success: false, error: "not found" };
  });
  return {
    manager: {
      getDraft: async (draftId: string) => {
        const item = byId.get(draftId);
        return item
          ? { success: true, draft: item }
          : { success: false, error: `Draft "${draftId}" was not found.` };
      },
      sendDraft,
    },
    byId,
    sendDraft,
  };
}

describe("scheduled time validation", () => {
  const now = new Date("2026-07-28T22:00:00.000Z");

  it("requires an explicit timezone offset", () => {
    expect(parseScheduledInstant("2026-07-29T07:00:00", now)).toMatchObject({
      success: false,
    });
    expect(parseScheduledInstant("2026-07-29T07:00:00+08:00", now)).toMatchObject({
      success: true,
      date: new Date("2026-07-28T23:00:00.000Z"),
    });
  });

  it("rejects past, near-immediate, and unreasonably distant schedules", () => {
    expect(parseScheduledInstant("2026-07-28T21:00:00Z", now).success).toBe(false);
    expect(parseScheduledInstant("2026-07-28T22:00:10Z", now).success).toBe(false);
    expect(parseScheduledInstant("2027-02-30T08:00:00+08:00", now).success).toBe(false);
    expect(parseScheduledInstant("2028-07-28T22:00:00Z", now).success).toBe(false);
  });
});

describe("ScheduledSendManager", () => {
  it("atomically schedules a reviewed batch and installs the worker once", async () => {
    const one = draft();
    const two = draft({
      draftId: "apple-draft:00000000-0000-4000-8000-000000000002",
      nativeId: "55903",
      messageId: "two@example.com",
      subject: "Second",
    });
    const fake = fakeDraftManager([one, two]);
    const ensureWorker = vi.fn(() => ({ success: true }));
    const manager = new ScheduledSendManager({
      registryPath: tempPath(),
      draftManager: fake.manager,
      now: () => new Date("2026-07-28T22:00:00.000Z"),
      ensureWorker,
    });

    const result = await manager.scheduleDrafts(
      [one.draftId, two.draftId],
      "2026-07-29T07:00:00+08:00"
    );

    expect(result.success).toBe(true);
    expect(result.schedules).toHaveLength(2);
    expect(result.schedules?.every((job) => job.status === "pending")).toBe(true);
    expect(result.schedules?.[0].sendAt).toBe("2026-07-28T23:00:00.000Z");
    expect(ensureWorker).toHaveBeenCalledTimes(1);
    expect(manager.activeForDraft(one.draftId)?.snapshot.subject).toBe("Reviewed");
  });

  it("writes nothing when one draft is missing or the worker cannot install", async () => {
    const one = draft();
    const registryPath = tempPath();
    const fake = fakeDraftManager([one]);
    const manager = new ScheduledSendManager({
      registryPath,
      draftManager: fake.manager,
      now: () => new Date("2026-07-28T22:00:00.000Z"),
      ensureWorker: () => ({ success: false, error: "launchd unavailable" }),
    });

    const missing = await manager.scheduleDrafts(
      [one.draftId, "apple-draft:00000000-0000-4000-8000-000000000099"],
      "2026-07-29T07:00:00+08:00"
    );
    expect(missing.success).toBe(false);
    expect(manager.list()).toEqual([]);

    const workerFailure = await manager.scheduleDrafts([one.draftId], "2026-07-29T07:00:00+08:00");
    expect(workerFailure).toMatchObject({ success: false, error: "launchd unavailable" });
    expect(manager.list()).toEqual([]);
  });

  it("fails closed when the schedule registry is corrupted", () => {
    const registryPath = tempPath();
    writeFileSync(registryPath, "{not-json");
    const manager = new ScheduledSendManager({ registryPath });

    expect(() => manager.list()).toThrow(/registry is unreadable/i);
  });

  it("refuses attached legacy drafts instead of risking attachment loss", async () => {
    const attached = draft({ hasAttachments: true });
    const fake = fakeDraftManager([attached]);
    const manager = new ScheduledSendManager({
      registryPath: tempPath(),
      draftManager: fake.manager,
      now: () => new Date("2026-07-28T22:00:00.000Z"),
    });

    expect(
      await manager.scheduleDrafts([attached.draftId], "2026-07-29T07:00:00+08:00")
    ).toMatchObject({ success: false });
  });

  it("schedules attached IMAP drafts because exact MIME is preserved", async () => {
    const attached = draft({
      hasAttachments: true,
      backend: "imap",
      sourceKind: "imap",
    });
    const fake = fakeDraftManager([attached]);
    const manager = new ScheduledSendManager({
      registryPath: tempPath(),
      draftManager: fake.manager,
      now: () => new Date("2026-07-28T22:00:00.000Z"),
    });

    expect(
      await manager.scheduleDrafts([attached.draftId], "2026-07-29T07:00:00+08:00")
    ).toMatchObject({ success: true });
  });

  it("sends an overdue unchanged draft exactly once", async () => {
    const reviewed = draft();
    const fake = fakeDraftManager([reviewed]);
    let now = new Date("2026-07-28T22:00:00.000Z");
    const manager = new ScheduledSendManager({
      registryPath: tempPath(),
      draftManager: fake.manager,
      now: () => now,
      ensureWorker: () => ({ success: true }),
    });
    await manager.scheduleDrafts([reviewed.draftId], "2026-07-29T07:00:00+08:00");

    expect(await manager.runDueSends()).toEqual([]);
    now = new Date("2026-07-29T03:00:00.000Z"); // Simulates wake several hours late.
    expect(await manager.runDueSends()).toEqual([expect.objectContaining({ status: "sent" })]);
    expect(await manager.runDueSends()).toEqual([]);
    expect(fake.sendDraft).toHaveBeenCalledTimes(1);
    expect(manager.list()[0]).toMatchObject({ status: "sent" });
  });

  it("fails safely without sending when reviewed content changed", async () => {
    const reviewed = draft();
    const fake = fakeDraftManager([reviewed]);
    let now = new Date("2026-07-28T22:00:00.000Z");
    const manager = new ScheduledSendManager({
      registryPath: tempPath(),
      draftManager: fake.manager,
      now: () => now,
      ensureWorker: () => ({ success: true }),
    });
    await manager.scheduleDrafts([reviewed.draftId], "2026-07-29T07:00:00+08:00");
    fake.byId.set(reviewed.draftId, {
      ...reviewed,
      body: "Changed after review",
      revision: "changed-revision",
    });
    now = new Date("2026-07-28T23:00:01.000Z");

    const result = await manager.runDueSends();

    expect(result[0]).toMatchObject({ status: "failed" });
    expect(result[0].error).toMatch(/changed after scheduling/i);
    expect(fake.sendDraft).not.toHaveBeenCalled();
  });

  it("supports rescheduling and cancellation only while pending", async () => {
    const reviewed = draft();
    const fake = fakeDraftManager([reviewed]);
    const manager = new ScheduledSendManager({
      registryPath: tempPath(),
      draftManager: fake.manager,
      now: () => new Date("2026-07-28T22:00:00.000Z"),
      ensureWorker: () => ({ success: true }),
    });
    const created = await manager.scheduleDrafts([reviewed.draftId], "2026-07-29T07:00:00+08:00");
    const scheduleId = created.schedules?.[0].scheduleId as string;

    expect(
      manager.reschedule(scheduleId, "2026-07-29T08:00:00+08:00").schedule?.requestedSendAt
    ).toBe("2026-07-29T08:00:00+08:00");
    expect(manager.cancel(scheduleId).schedule?.status).toBe("cancelled");
    expect(manager.reschedule(scheduleId, "2026-07-29T09:00:00+08:00").success).toBe(false);
  });

  it("moves a stale sending claim to needs_review and never retries it", async () => {
    const reviewed = draft();
    const fake = fakeDraftManager([reviewed]);
    const registryPath = tempPath();
    let now = new Date("2026-07-28T22:00:00.000Z");
    const manager = new ScheduledSendManager({
      registryPath,
      draftManager: fake.manager,
      now: () => now,
      ensureWorker: () => ({ success: true }),
    });
    await manager.scheduleDrafts([reviewed.draftId], "2026-07-29T07:00:00+08:00");
    const stored = JSON.parse(readFileSync(registryPath, "utf8")) as {
      jobs: Record<string, { status: string; startedAt?: string }>;
    };
    const job = Object.values(stored.jobs)[0];
    job.status = "sending";
    job.startedAt = "2026-07-28T21:50:00.000Z";
    writeFileSync(registryPath, `${JSON.stringify(stored)}\n`);
    now = new Date("2026-07-28T22:10:00.000Z");

    expect(await manager.runDueSends()).toEqual([]);
    expect(manager.list()[0]).toMatchObject({ status: "needs_review" });
    expect(fake.sendDraft).not.toHaveBeenCalled();
  });
});

describe("scheduled-send LaunchAgent", () => {
  it("writes a crash-restart per-user worker without embedding mail content", () => {
    const homeDir = tempPath("home");
    const nodePath = join(dirnameOf(homeDir), "node");
    const workerPath = join(dirnameOf(homeDir), "schedulerCli.js");
    writeFileSync(nodePath, "");
    writeFileSync(workerPath, "");
    const calls: string[][] = [];
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "print"
        ? { status: 1, stdout: "", stderr: "not loaded" }
        : { status: 0, stdout: "", stderr: "" };
    }) as unknown as typeof import("child_process").spawnSync;

    const result = ensureScheduledSendLaunchAgent({
      nodePath,
      workerPath,
      homeDir,
      uid: 501,
      spawn,
    });

    expect(result.success).toBe(true);
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "io.github.yu2001-s.apple-mail.scheduled-send.plist"
    );
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).not.toContain("<key>StartInterval</key>");
    expect(plist).toContain(nodePath);
    expect(plist).toContain(workerPath);
    expect(plist).not.toContain("Reviewed");
    expect(calls.some((args) => args[0] === "bootstrap")).toBe(true);
  });

  it("escapes paths in the generated plist", () => {
    const plist = buildScheduledSendLaunchAgentPlist({
      nodePath: "/tmp/Node & Tools/node",
      workerPath: "/tmp/<worker>.js",
    });
    expect(plist).toContain("/tmp/Node &amp; Tools/node");
    expect(plist).toContain("/tmp/&lt;worker&gt;.js");
  });
});

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
