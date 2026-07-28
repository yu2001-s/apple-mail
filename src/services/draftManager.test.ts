import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildListDraftsAppleScript, DraftManager } from "@/services/draftManager.js";
import type { AppleScriptResult } from "@/types.js";

const FS = "\u241fAPPLE_MAIL_DRAFT_FIELD\u241f";
const RS = "\u241eAPPLE_MAIL_DRAFT_RECORD\u241e";
const AS = "\u241dAPPLE_MAIL_DRAFT_ADDRESS\u241d";

function row(input: {
  id: string;
  from?: string;
  subject?: string;
  body?: string;
  visible?: boolean;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  sourceKind?: "compose" | "mailbox";
  accountId?: string;
  accountName?: string;
  mailboxName?: string;
  messageId?: string;
  hasAttachments?: boolean;
}): string {
  const base = [
    input.id,
    input.from ?? "Tester <test@example.com>",
    input.subject ?? "Subject",
    input.body ?? "Body",
    String(input.visible ?? false),
    (input.to ?? ["to@example.com"]).join(AS),
    (input.cc ?? []).join(AS),
    (input.bcc ?? []).join(AS),
  ];
  if (!input.sourceKind) return [...base, ""].join(FS);
  return [
    ...base,
    input.sourceKind,
    input.accountId ?? "",
    input.accountName ?? "",
    input.mailboxName ?? "",
    input.messageId ?? "",
    String(input.hasAttachments ?? false),
    "",
  ].join(FS);
}

const tempDirs: string[] = [];
function tempRegistry(): string {
  const dir = mkdtempSync(join(tmpdir(), "apple-mail-drafts-"));
  tempDirs.push(dir);
  return join(dir, "registry.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DraftManager sending identities", () => {
  it("lists every alias separately and marks the Mail default", () => {
    const execute = (): AppleScriptResult => ({
      success: true,
      output: [
        [
          "acct-1",
          "Work",
          "Ada Lovelace",
          "ada@example.com",
          "true",
          "Ada <alias@example.com>",
        ].join(FS),
        [
          "acct-1",
          "Work",
          "Ada Lovelace",
          "alias@example.com",
          "true",
          "Ada <alias@example.com>",
        ].join(FS),
      ].join(RS),
    });
    const manager = new DraftManager({ registryPath: tempRegistry(), execute });

    const identities = manager.listSendingIdentities();

    expect(identities).toHaveLength(2);
    expect(identities.map((identity) => identity.email)).toEqual([
      "ada@example.com",
      "alias@example.com",
    ]);
    expect(identities[1]).toMatchObject({
      accountName: "Work",
      sender: "Ada Lovelace <alias@example.com>",
      isDefault: true,
      enabled: true,
    });
    expect(identities[0].identityId).toMatch(/^mail-identity:[0-9a-f]{24}$/);
  });

  it("stores a plugin-local default identity without changing Mail", () => {
    const identityRows = [
      ["acct-1", "Work", "Ada", "ada@example.com", "true", "Ada <ada@example.com>"].join(FS),
      ["acct-1", "Work", "Ada", "alias@example.com", "true", "Ada <ada@example.com>"].join(FS),
    ].join(RS);
    const registryPath = tempRegistry();
    const manager = new DraftManager({
      registryPath,
      execute: () => ({ success: true, output: identityRows }),
    });

    const selected = manager.setDefaultIdentity("alias@example.com");

    expect(selected?.email).toBe("alias@example.com");
    expect(manager.getDefaultIdentity()?.email).toBe("alias@example.com");
    const stored = JSON.parse(readFileSync(registryPath, "utf8")) as {
      defaultIdentityId?: string;
    };
    expect(stored.defaultIdentityId).toBe(selected?.identityId);
  });
});

describe("DraftManager stable draft ids", () => {
  it("indexes saved Drafts mailboxes instead of only active compose sessions", () => {
    const script = buildListDraftsAppleScript();

    expect(script).toContain("messages of concreteMailbox");
    expect(script).toContain('mailboxNameText is "Drafts"');
    expect(script).not.toContain("every outgoing message");
  });

  it("lists a saved mailbox draft with its stable mailbox locator", () => {
    const saved = row({
      id: "55902",
      sourceKind: "mailbox",
      accountId: "account-1",
      accountName: "iCloud",
      mailboxName: "Drafts",
      messageId: "message-id@example.com",
      subject: "Saved draft",
      body: "\nSaved body\n",
    });
    const manager = new DraftManager({
      registryPath: tempRegistry(),
      execute: () => ({ success: true, output: saved }),
    });

    const listed = manager.listDrafts();

    expect(listed.success).toBe(true);
    expect(listed.drafts?.[0]).toMatchObject({
      nativeId: "55902",
      sourceKind: "mailbox",
      accountId: "account-1",
      accountName: "iCloud",
      mailboxName: "Drafts",
      messageId: "message-id@example.com",
      hasAttachments: false,
    });
  });

  it("keeps the same draft id when Mail changes its native id", () => {
    const registryPath = tempRegistry();
    let nativeId = "3";
    const execute = (): AppleScriptResult => ({
      success: true,
      output: row({ id: nativeId, subject: "Stable", body: "Same body" }),
    });

    const first = new DraftManager({ registryPath, execute }).listDrafts();
    nativeId = "19";
    const second = new DraftManager({ registryPath, execute }).listDrafts();

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.drafts?.[0].draftId).toBe(second.drafts?.[0].draftId);
    expect(second.drafts?.[0].nativeId).toBe("19");
  });

  it("returns the same stable draft id after an in-place update", () => {
    const registryPath = tempRegistry();
    const current = row({ id: "7", subject: "Before", body: "Old" });
    const replacement = row({ id: "8", subject: "After", body: "New" });
    const execute = (script: string): AppleScriptResult => {
      if (script.includes("set discardResult")) {
        return { success: true, output: "discarded|backing-deleted" };
      }
      if (script.includes("make new outgoing message with properties")) {
        return { success: true, output: replacement };
      }
      return { success: true, output: current };
    };
    const manager = new DraftManager({ registryPath, execute });
    const listed = manager.listDrafts();
    const draftId = listed.drafts?.[0].draftId as string;

    const updated = manager.updateDraft(draftId, { subject: "After", body: "New" });

    expect(updated.success).toBe(true);
    expect(updated.draft).toMatchObject({
      draftId,
      nativeId: "8",
      subject: "After",
      body: "New",
    });
  });

  it("recreates a saved mailbox draft and deletes only its exact backing message", () => {
    const registryPath = tempRegistry();
    const current = row({
      id: "55902",
      sourceKind: "mailbox",
      accountId: "account-1",
      accountName: "iCloud",
      mailboxName: "Drafts",
      messageId: "old@example.com",
      subject: "Before",
      body: "\nOld\n",
    });
    const replacement = row({ id: "9", subject: "After", body: "Old" });
    const scripts: string[] = [];
    const execute = (script: string): AppleScriptResult => {
      scripts.push(script);
      if (script.includes("set targetMatches")) {
        return { success: true, output: "backing-deleted" };
      }
      if (script.includes("make new outgoing message with properties")) {
        return { success: true, output: replacement };
      }
      return { success: true, output: current };
    };
    const manager = new DraftManager({ registryPath, execute });
    const draftId = manager.listDrafts().drafts?.[0].draftId as string;

    const updated = manager.updateDraft(draftId, { subject: "After" });

    expect(updated.success).toBe(true);
    expect(updated.draft).toMatchObject({ draftId, nativeId: "9", subject: "After" });
    expect(scripts.some((script) => script.includes("set targetMatches"))).toBe(true);
    expect(scripts.some((script) => script.includes("whose id is 55902"))).toBe(true);
  });

  it("rejects an unknown or malformed draft id", () => {
    const manager = new DraftManager({
      registryPath: tempRegistry(),
      execute: () => ({ success: true, output: "" }),
    });
    expect(manager.updateDraft("7", { subject: "No" }).success).toBe(false);
    expect(
      manager.updateDraft("apple-draft:00000000-0000-4000-8000-000000000000", {
        subject: "No",
      }).error
    ).toMatch(/not found/i);
  });
});

describe("DraftManager create and send", () => {
  it("creates a registered draft with the requested alias", () => {
    const identityRows = [
      ["acct-1", "Work", "Ada", "alias@example.com", "true", "Ada <alias@example.com>"].join(FS),
    ].join(RS);
    const createdRow = row({
      id: "12",
      from: "Ada <alias@example.com>",
      subject: "Hello",
      body: "Draft body",
    });
    const execute = (script: string): AppleScriptResult => {
      if (script.includes("set identityRows")) return { success: true, output: identityRows };
      return { success: true, output: createdRow };
    };
    const manager = new DraftManager({ registryPath: tempRegistry(), execute });

    const result = manager.createDraft({
      from: "alias@example.com",
      to: ["to@example.com"],
      subject: "Hello",
      body: "Draft body",
    });

    expect(result.success).toBe(true);
    expect(result.draft?.draftId).toMatch(/^apple-draft:/);
    expect(result.draft?.from).toBe("Ada <alias@example.com>");
  });

  it("sends only the selected registered draft", () => {
    const registryPath = tempRegistry();
    const draftRow = row({ id: "4", subject: "Ready" });
    const execute = (script: string): AppleScriptResult =>
      script.includes("send draftMessage")
        ? { success: true, output: "sent" }
        : { success: true, output: draftRow };
    const manager = new DraftManager({ registryPath, execute });
    const draftId = manager.listDrafts().drafts?.[0].draftId as string;

    const sent = manager.sendDraft(draftId);

    expect(sent.success).toBe(true);
    expect(sent.draft?.subject).toBe("Ready");
  });

  it("tombstones a deleted draft so a stale Mail compose object stays hidden", () => {
    const registryPath = tempRegistry();
    const draftRow = row({ id: "5", subject: "Discard me", body: "Exact body" });
    const execute = (script: string): AppleScriptResult =>
      script.includes("set discardResult")
        ? { success: true, output: "discarded|backing-deleted" }
        : { success: true, output: draftRow };
    const manager = new DraftManager({ registryPath, execute });
    const draftId = manager.listDrafts().drafts?.[0].draftId as string;

    const deleted = manager.deleteDraft(draftId);
    const after = manager.listDrafts();

    expect(deleted.success).toBe(true);
    expect(after.success).toBe(true);
    expect(after.drafts).toEqual([]);
  });

  it("keeps a discarded compose draft hidden when Mail wraps its saved body in whitespace", () => {
    const registryPath = tempRegistry();
    const liveRow = row({ id: "5", subject: "Discard me", body: "Exact body" });
    const liveManager = new DraftManager({
      registryPath,
      execute: (script: string) =>
        script.includes("set discardResult")
          ? { success: true, output: "discarded|backing-deleted" }
          : { success: true, output: liveRow },
    });
    const draftId = liveManager.listDrafts().drafts?.[0].draftId as string;
    expect(liveManager.deleteDraft(draftId).success).toBe(true);

    const savedRow = row({
      id: "55902",
      sourceKind: "mailbox",
      accountId: "account-1",
      mailboxName: "Drafts",
      messageId: "old-draft@example.com",
      subject: "Discard me",
      body: "\nExact body \n",
    });
    const savedManager = new DraftManager({
      registryPath,
      execute: () => ({ success: true, output: savedRow }),
    });

    expect(savedManager.listDrafts().drafts).toEqual([]);
    const stored = JSON.parse(readFileSync(registryPath, "utf8")) as {
      discardedFingerprints?: Record<string, string>;
      discardedLocators?: Record<string, string>;
    };
    expect(Object.keys(stored.discardedLocators ?? {})).toHaveLength(1);

    // Once a saved Message-ID is tied to the discarded compose fingerprint,
    // it remains hidden even after the short-lived fingerprint tombstone is
    // gone. A newly-created identical draft gets a different Message-ID and
    // therefore remains visible.
    stored.discardedFingerprints = {};
    const newMessageIdRow = row({
      id: "55903",
      sourceKind: "mailbox",
      accountId: "account-1",
      mailboxName: "Drafts",
      messageId: "new-draft@example.com",
      subject: "Discard me",
      body: "\nExact body \n",
    });
    writeFileSync(registryPath, `${JSON.stringify(stored)}\n`);
    const afterExpiry = new DraftManager({
      registryPath,
      execute: () => ({ success: true, output: [savedRow, newMessageIdRow].join(RS) }),
    }).listDrafts();
    expect(afterExpiry.drafts).toHaveLength(1);
    expect(afterExpiry.drafts?.[0].messageId).toBe("new-draft@example.com");
  });
});
