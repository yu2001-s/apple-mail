import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapDraftManager, type ImapDraftManagerOptions } from "@/services/imapDraftManager.js";
import type { ImapClientLike, ImapConfig } from "@/services/imapClient.js";
import type { SendingIdentity } from "@/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function identity(): SendingIdentity {
  return {
    identityId: "mail-identity:test",
    accountId: "account-1",
    accountName: "iCloud",
    email: "sender@example.com",
    fullName: "Sender",
    sender: "Sender <sender@example.com>",
    enabled: true,
    isDefault: true,
  };
}

function fakeImap() {
  const boxes = new Map<string, Map<number, Buffer>>([
    ["Drafts", new Map()],
    ["Sent", new Map()],
  ]);
  let selected = "Drafts";
  let nextUid = 1;
  const client = {
    connect: async () => undefined,
    getMailboxLock: async (path: string) => {
      selected = path;
      return { release: () => undefined };
    },
    search: async (query: Record<string, unknown>) => {
      const header = query.header as Record<string, string> | undefined;
      const entries = [...(boxes.get(selected)?.entries() ?? [])];
      if (!header) return entries.map(([uid]) => uid);
      const [name, value] = Object.entries(header)[0] ?? [];
      if (!name) return [];
      const pattern = new RegExp(`^${name}:.*${value}`, "im");
      return entries.filter(([, raw]) => pattern.test(raw.toString())).map(([uid]) => uid);
    },
    fetch: async function* () {
      yield* [];
    },
    fetchOne: async (range: string) => {
      const raw = boxes.get(selected)?.get(Number(range));
      return raw ? { uid: Number(range), source: raw } : false;
    },
    list: async () => [
      { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
      { path: "Sent", name: "Sent", specialUse: "\\Sent" },
    ],
    status: async (path: string) => ({ path }),
    download: async () => ({
      content: (async function* () {
        yield new Uint8Array();
      })(),
    }),
    mailboxCreate: async (path: string) => ({ path, created: true }),
    mailboxRename: async (path: string, newPath: string) => ({ path, newPath }),
    mailboxDelete: async (path: string) => ({ path }),
    append: async (path: string, content: string | Buffer) => {
      const uid = nextUid++;
      boxes.get(path)?.set(uid, Buffer.isBuffer(content) ? content : Buffer.from(content));
      return { destination: path, uid };
    },
    messageFlagsAdd: async () => true,
    messageFlagsRemove: async () => true,
    messageMove: async () => true,
    messageDelete: async (uids: number[]) => {
      for (const uid of uids) boxes.get(selected)?.delete(uid);
      return true;
    },
    noop: async () => undefined,
    logout: async () => undefined,
    close: () => undefined,
  } as unknown as ImapClientLike;
  return { client, boxes };
}

function managerOptions(
  client: ImapClientLike,
  overrides: Partial<ImapDraftManagerOptions> = {}
): ImapDraftManagerOptions {
  const dir = mkdtempSync(join(tmpdir(), "apple-mail-imap-drafts-"));
  tempDirs.push(dir);
  const config: ImapConfig = {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "sender@example.com",
    pass: "test-only",
    accountLabel: "iCloud",
  };
  const sender = identity();
  return {
    registryPath: join(dir, "registry.json"),
    resolveIdentity: (selector) =>
      !selector ||
      selector === sender.identityId ||
      selector === sender.email ||
      selector === sender.sender
        ? sender
        : null,
    imapAccount: () => "iCloud",
    imapDeps: () => ({ config, connect: async () => client }),
    smtpConfig: () => ({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: sender.email,
      pass: "test-only",
      from: sender.email,
    }),
    sleep: async () => undefined,
    ...overrides,
  };
}

describe("IMAP-backed drafts", () => {
  it("creates a server Drafts resource and round-trips clean MIME", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(managerOptions(fake.client));
    const created = await manager.createDraft({
      from: "sender@example.com",
      to: ["to@example.com"],
      bcc: ["hidden@example.com"],
      subject: "同步草稿",
      body: "乾淨內容",
      htmlBody: "<p>乾淨內容</p>",
      attachments: [
        {
          filename: "report.txt",
          contentBase64: Buffer.from("report").toString("base64"),
        },
      ],
    });

    expect(created.success).toBe(true);
    expect(created.draft).toMatchObject({
      backend: "imap",
      subject: "同步草稿",
      bcc: ["hidden@example.com"],
      hasAttachments: true,
    });
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    const reread = await manager.getDraft(created.draft?.draftId as string);
    expect(reread.draft?.attachments?.[0]).toMatchObject({
      name: "report.txt",
      size: 6,
    });
  });

  it("replaces atomically, preserves stable id, edits attachments, and rejects stale revisions", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(managerOptions(fake.client));
    const created = await manager.createDraft({
      to: ["to@example.com"],
      subject: "Before",
      body: "Before",
      attachments: [
        { filename: "old.txt", contentBase64: Buffer.from("old").toString("base64") },
        { filename: "keep.txt", contentBase64: Buffer.from("keep").toString("base64") },
      ],
    });
    const draftId = created.draft?.draftId as string;
    const oldRevision = created.draft?.revision as string;

    const updated = await manager.updateDraft(draftId, {
      expectedRevision: oldRevision,
      subject: "After",
      body: "After",
      attachmentNamesToRemove: ["old.txt"],
      attachmentsToAdd: [
        { filename: "new.txt", contentBase64: Buffer.from("new").toString("base64") },
      ],
    });

    expect(updated.success).toBe(true);
    expect(updated.draft?.draftId).toBe(draftId);
    expect(updated.draft?.revision).not.toBe(oldRevision);
    expect(updated.draft?.attachments?.map((item) => item.name)).toEqual(["keep.txt", "new.txt"]);
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    expect(
      await manager.updateDraft(draftId, {
        expectedRevision: oldRevision,
        body: "stale overwrite",
      })
    ).toMatchObject({ success: false, error: expect.stringMatching(/revision conflict/i) });
  });

  it("sends the reviewed revision once, strips private headers, syncs Sent, and removes Drafts", async () => {
    const fake = fakeImap();
    let submitted = Buffer.alloc(0);
    const smtpSend = vi.fn(async (raw: Buffer) => {
      submitted = raw;
      return { success: true, messageId: "<smtp-result@example.com>" };
    });
    const manager = new ImapDraftManager(managerOptions(fake.client, { smtpSend }));
    const created = await manager.createDraft({
      to: ["to@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Send",
      body: "Exact body",
      attachments: [
        { filename: "a.txt", contentBase64: Buffer.from("attachment").toString("base64") },
      ],
    });
    const draftId = created.draft?.draftId as string;

    const sent = await manager.sendDraft(draftId, created.draft?.revision);

    expect(sent.success).toBe(true);
    expect(sent.smtpMessageId).toBe("<smtp-result@example.com>");
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect(submitted.toString()).toContain("Exact body");
    expect(submitted.toString()).not.toMatch(/^Bcc:/im);
    expect(submitted.toString()).not.toMatch(/^X-Apple-Mail-Plugin-Draft-ID:/im);
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
    expect(fake.boxes.get("Sent")?.size).toBe(1);

    const repeated = await manager.sendDraft(draftId, created.draft?.revision);
    expect(repeated.success).toBe(true);
    expect(repeated.warning).toMatch(/already sent/i);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft editable after a definite SMTP rejection", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(
      managerOptions(fake.client, {
        smtpSend: async () => ({ success: false, error: "550 rejected" }),
      })
    );
    const created = await manager.createDraft({
      to: ["to@example.com"],
      subject: "Keep on failure",
      body: "Body",
    });

    const sent = await manager.sendDraft(created.draft?.draftId as string, created.draft?.revision);

    expect(sent).toMatchObject({ success: false, error: "550 rejected" });
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    const reread = await manager.getDraft(created.draft?.draftId as string);
    expect(reread.draft?.deliveryState).toBe("draft");
  });

  it("locks an uncertain SMTP outcome for manual Sent review", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(
      managerOptions(fake.client, {
        smtpSend: async () => ({
          success: false,
          error: "socket closed",
          uncertain: true,
        }),
      })
    );
    const created = await manager.createDraft({
      to: ["to@example.com"],
      subject: "Uncertain",
      body: "Body",
    });

    const sent = await manager.sendDraft(created.draft?.draftId as string, created.draft?.revision);

    expect(sent.error).toMatch(/verify Sent/i);
    const reread = await manager.getDraft(created.draft?.draftId as string);
    expect(reread.draft?.deliveryState).toBe("needs_review");
    expect(await manager.sendDraft(created.draft?.draftId as string)).toMatchObject({
      success: false,
      error: expect.stringMatching(/avoid a duplicate/i),
    });
    expect(
      await manager.resolveUncertainSend(created.draft?.draftId as string, "not_sent")
    ).toMatchObject({
      success: true,
      draft: expect.objectContaining({ deliveryState: "draft" }),
    });
  });
});
