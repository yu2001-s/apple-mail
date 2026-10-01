import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapDraftManager, type ImapDraftManagerOptions } from "@/services/imapDraftManager.js";
import type { ImapClientLike, ImapConfig } from "@/services/imapClient.js";
import type { SendingIdentity } from "@/types.js";
import { encodeImapId } from "@/services/imapClient.js";
import { parseDraftMime } from "@/services/mimeDraft.js";

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
    ["INBOX", new Map()],
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
  const originalId = encodeImapId("iCloud", "INBOX", 100);
  function seedOriginal(fake: ReturnType<typeof fakeImap>, headers: string[] = []) {
    fake.boxes
      .get("INBOX")!
      .set(
        100,
        Buffer.from(
          [
            ...headers,
            'From: "Su, Doctor" <president@example.com>',
            "To: sender@example.com, hello@example.com, colleague@example.com",
            "Cc: colleague@example.com, nurse@example.com",
            "Bcc: private@example.com",
            `Subject: =?UTF-8?B?${Buffer.from("Re: 醫療減負合作交流").toString("base64")}?=`,
            "Message-ID: <parent@example.com>",
            "References: <Root@example.com>\r\n <root@example.com>",
            "In-Reply-To: <previous@example.com>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Original message text",
          ].join("\r\n")
        )
      );
  }

  it("previews without mutations, honors Reply-To and preserves the exact reply body", async () => {
    const fake = fakeImap();
    seedOriginal(fake, ["Reply-To: director@example.com"]);
    const smtpSend = vi.fn();
    const manager = new ImapDraftManager(
      managerOptions(fake.client, {
        smtpSend,
        selfAddresses: ["hello@example.com"],
      })
    );
    const preview = await manager.previewReply({
      originalMessageId: originalId,
      body: "謝謝您協助轉介！",
    });
    expect(preview).toMatchObject({
      success: true,
      reply: {
        from: "sender@example.com",
        to: ["director@example.com"],
        subject: "Re: 醫療減負合作交流",
        body: "謝謝您協助轉介！",
        inReplyTo: "<parent@example.com>",
        references: [
          "<Root@example.com>",
          "<root@example.com>",
          "<previous@example.com>",
          "<parent@example.com>",
        ],
      },
    });
    expect(preview.reply?.cc).toBeUndefined();
    expect(preview.reply?.bcc).toBeUndefined();
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
    expect(smtpSend).not.toHaveBeenCalled();
  });

  it("reply-all excludes configured aliases and Bcc; quoting is opt-in", async () => {
    const fake = fakeImap();
    seedOriginal(fake);
    const manager = new ImapDraftManager(
      managerOptions(fake.client, { selfAddresses: ["HELLO@example.com"] })
    );
    const result = await manager.createReplyDraft({
      originalMessageId: originalId,
      body: "Thanks",
      replyAll: true,
      quoteOriginal: true,
    });
    expect(result.success).toBe(true);
    expect(result.draft).toMatchObject({
      to: ["president@example.com"],
      cc: ["colleague@example.com", "nurse@example.com"],
      bcc: [],
    });
    expect(result.draft?.body).toContain("> Original message text");
    expect(result.draft?.hasAttachments).toBe(false);
  });

  it("keeps reply threading through edits, rejects stale send revisions, and submits once", async () => {
    const fake = fakeImap();
    seedOriginal(fake);
    const smtpSend = vi.fn(async () => ({ success: true, messageId: "<sent@example.com>" }));
    const manager = new ImapDraftManager(managerOptions(fake.client, { smtpSend }));
    const created = await manager.createReplyDraft({
      originalMessageId: originalId,
      body: "First draft",
    });
    const draftId = created.draft!.draftId;
    const edited = await manager.updateDraft(draftId, {
      expectedRevision: created.draft!.revision,
      body: "謝謝您協助轉介！",
    });
    expect(edited.draft).toMatchObject({
      inReplyTo: "<parent@example.com>",
      references: created.draft!.references,
    });
    expect(await manager.sendDraft(draftId, created.draft!.revision)).toMatchObject({
      success: false,
      error: expect.stringMatching(/revision conflict/),
    });
    expect(smtpSend).not.toHaveBeenCalled();
    const read = await manager.getDraft(draftId);
    const sent = await manager.sendDraft(draftId, read.draft!.revision);
    expect(sent.success).toBe(true);
    const raw = (smtpSend.mock.calls[0] as unknown as [Buffer])[0];
    expect(parseDraftMime(raw)).toMatchObject({
      inReplyTo: "<parent@example.com>",
      references: created.draft!.references,
      body: "謝謝您協助轉介！",
    });
    expect(fake.boxes.get("Sent")?.size).toBe(1);
    await manager.sendDraft(draftId, read.draft!.revision);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("does not send a follow-up to our own address when the original was sent by us", async () => {
    const fake = fakeImap();
    seedOriginal(fake, ["From: sender@example.com", "Reply-To: sender@example.com"]);
    const manager = new ImapDraftManager(
      managerOptions(fake.client, { selfAddresses: ["hello@example.com"] })
    );
    const preview = await manager.previewReply({
      originalMessageId: originalId,
      body: "Following up",
    });
    expect(preview.reply?.to).toEqual(["colleague@example.com"]);
  });

  it("rejects missing source IDs, foreign accounts and malformed original Message-ID before creating a draft", async () => {
    const fake = fakeImap();
    seedOriginal(fake, ["Message-ID: invalid"]);
    const manager = new ImapDraftManager(managerOptions(fake.client));
    for (const id of [
      originalId,
      encodeImapId("other-account", "INBOX", 100),
      encodeImapId("iCloud", "INBOX", 999),
    ]) {
      expect(
        await manager.createReplyDraft({ originalMessageId: id, body: "Thanks" })
      ).toMatchObject({ success: false });
    }
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
  });

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
