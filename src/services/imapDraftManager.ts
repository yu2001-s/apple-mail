import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { AttachmentInput, Draft, SendingIdentity } from "@/types.js";
import {
  imapAppendRawMessage,
  imapDeleteExactMessage,
  imapFetchRawMessage,
  imapFindRawMessageByHeader,
  isImapAccount,
  decodeImapId,
  type ImapDeps,
} from "@/services/imapClient.js";
import {
  composeDraftMime,
  DRAFT_ID_HEADER,
  draftMimeRevision,
  mimeAttachmentsForResource,
  parseDraftMime,
  prepareDraftMimeForSend,
  type MimeDraftAttachment,
} from "@/services/mimeDraft.js";
import {
  resolveSmtpConfigForIdentity,
  sendRawViaSmtp,
  type SmtpConfig,
  type SmtpSendResult,
} from "@/services/smtpMailer.js";
import { buildReplyOptions, parseOriginalHeaders } from "@/services/replyForward.js";
import { z } from "zod";

const DRAFT_PREFIX = "apple-draft:";

interface ImapDraftRegistryEntry {
  imapId: string;
  account: string;
  identityId: string;
  fromEmail: string;
  identitySender?: string;
  identityAccountId?: string;
  identityAccountName?: string;
  revision: string;
  messageId?: string;
  updatedAt: string;
  state: "draft" | "sending" | "sent" | "needs_review";
  smtpMessageId?: string;
  sentImapId?: string;
  warning?: string;
}

interface ImapDraftRegistry {
  version: 1;
  drafts: Record<string, ImapDraftRegistryEntry>;
}

export interface ImapDraftCreateInput {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: AttachmentInput[];
  inReplyTo?: string;
  references?: string[];
}

export interface ImapReplyInput {
  originalMessageId: string;
  body: string;
  from?: string;
  replyAll?: boolean;
  /** Opt in to quoting the original; otherwise preserve the supplied body exactly. */
  quoteOriginal?: boolean;
}

export interface ImapReplyPreviewResult {
  success: boolean;
  reply?: ImapDraftCreateInput;
  error?: string;
}

export interface ImapDraftUpdate {
  expectedRevision?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string | null;
  attachmentsToAdd?: AttachmentInput[];
  attachmentNamesToRemove?: string[];
}

export interface ImapDraftResult {
  success: boolean;
  draft?: Draft;
  error?: string;
  warning?: string;
  smtpMessageId?: string;
  sentMessageId?: string;
}

export interface ImapDraftManagerOptions {
  registryPath?: string;
  resolveIdentity: (selector?: string) => SendingIdentity | null;
  imapDeps?: (account: string) => ImapDeps;
  imapAccount?: (identity: SendingIdentity) => string;
  smtpConfig?: (identity: SendingIdentity) => SmtpConfig;
  smtpSend?: typeof sendRawViaSmtp;
  sleep?: (ms: number) => Promise<void>;
  /** Configured aliases excluded from reply recipients. */
  selfAddresses?: string[];
}

function defaultRegistryPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "apple-mail-mcp",
    "imap-draft-registry.json"
  );
}

function emptyRegistry(): ImapDraftRegistry {
  return { version: 1, drafts: {} };
}

function senderEmail(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

function draftUuid(draftId: string): string {
  return draftId.startsWith(DRAFT_PREFIX) ? draftId.slice(DRAFT_PREFIX.length) : "";
}

export class ImapDraftManager {
  private readonly registryPath: string;
  private readonly identityResolver: (selector?: string) => SendingIdentity | null;
  private readonly depsForAccount: (account: string) => ImapDeps;
  private readonly accountForIdentity?: (identity: SendingIdentity) => string;
  private readonly smtpConfigResolver: (identity: SendingIdentity) => SmtpConfig;
  private readonly smtpSend: typeof sendRawViaSmtp;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly selfAddresses: string[];

  constructor(options: ImapDraftManagerOptions) {
    this.registryPath = options.registryPath ?? defaultRegistryPath();
    this.identityResolver = options.resolveIdentity;
    this.depsForAccount = options.imapDeps ?? ((account) => ({ account }));
    this.accountForIdentity = options.imapAccount;
    this.smtpConfigResolver =
      options.smtpConfig ??
      ((identity) =>
        resolveSmtpConfigForIdentity({
          email: identity.email,
          account: identity.accountName,
        }));
    this.smtpSend = options.smtpSend ?? sendRawViaSmtp;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.selfAddresses = options.selfAddresses ?? [];
  }

  private load(): ImapDraftRegistry {
    if (!existsSync(this.registryPath)) return emptyRegistry();
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as ImapDraftRegistry;
      if (parsed.version !== 1 || !parsed.drafts || typeof parsed.drafts !== "object") {
        throw new Error("unsupported registry format");
      }
      return parsed;
    } catch (error) {
      throw new Error(
        `IMAP draft registry is unreadable; no drafts were changed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private save(registry: ImapDraftRegistry): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, this.registryPath);
  }

  owns(draftId: string): boolean {
    return Boolean(this.load().drafts[draftUuid(draftId)]);
  }

  private identityFor(selector?: string): SendingIdentity {
    const identity = this.identityResolver(selector);
    if (!identity?.enabled) {
      throw new Error(
        selector
          ? `Sending identity "${selector}" was not found or is disabled.`
          : "No enabled default sending identity is available."
      );
    }
    return identity;
  }

  private identityForEntry(entry: ImapDraftRegistryEntry): SendingIdentity {
    if (entry.identitySender && entry.identityAccountName) {
      return {
        identityId: entry.identityId,
        accountId: entry.identityAccountId ?? "",
        accountName: entry.identityAccountName,
        email: entry.fromEmail,
        fullName: "",
        sender: entry.identitySender,
        enabled: true,
        isDefault: false,
      };
    }
    return this.identityFor(entry.identityId || entry.fromEmail);
  }

  private imapAccountFor(identity: SendingIdentity): string {
    if (this.accountForIdentity) return this.accountForIdentity(identity);
    if (isImapAccount(identity.accountName)) return identity.accountName;
    if (isImapAccount(identity.email)) return identity.email;
    throw new Error(
      `No unambiguous IMAP profile matches ${identity.sender}. Configure account "${identity.accountName}" or address "${identity.email}" in APPLE_MAIL_MCP_IMAP_ACCOUNTS.`
    );
  }

  canCreate(selector?: string): boolean {
    try {
      const identity = this.identityFor(selector);
      this.imapAccountFor(identity);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchCurrent(
    uuid: string,
    entry: ImapDraftRegistryEntry
  ): Promise<{ raw: Buffer; imapId: string; revision: string } | null> {
    const deps = this.depsForAccount(entry.account);
    let current = await imapFetchRawMessage(entry.imapId, deps);
    if (!current) {
      current = await imapFindRawMessageByHeader(
        "drafts",
        { name: DRAFT_ID_HEADER, value: uuid },
        deps
      );
    }
    if (!current && entry.messageId) {
      current = await imapFindRawMessageByHeader(
        "drafts",
        { name: "Message-ID", value: entry.messageId },
        deps
      );
    }
    if (!current) return null;
    const revision = draftMimeRevision(current.raw);
    if (current.id !== entry.imapId || revision !== entry.revision) {
      const registry = this.load();
      const latest = registry.drafts[uuid];
      if (latest) {
        latest.imapId = current.id;
        latest.revision = revision;
        latest.updatedAt = new Date().toISOString();
        this.save(registry);
      }
    }
    return { raw: current.raw, imapId: current.id, revision };
  }

  private toDraft(
    draftId: string,
    entry: ImapDraftRegistryEntry,
    raw: Buffer,
    imapId = entry.imapId
  ): Draft {
    const parsed = parseDraftMime(raw);
    return {
      draftId,
      revision: draftMimeRevision(raw),
      nativeId: imapId,
      from: parsed.from || entry.fromEmail,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      body: parsed.body,
      htmlBody: parsed.htmlBody,
      visible: false,
      sourceKind: "imap",
      accountName: entry.account,
      mailboxName: imapId,
      messageId: parsed.messageId ?? entry.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      hasAttachments: parsed.attachments.length > 0,
      attachments: mimeAttachmentsForResource(parsed, draftId),
      backend: "imap",
      deliveryState: entry.state,
    };
  }

  async listDrafts(): Promise<{ success: boolean; drafts?: Draft[]; error?: string }> {
    try {
      const registry = this.load();
      const drafts: Draft[] = [];
      for (const [uuid, entry] of Object.entries(registry.drafts)) {
        if (entry.state === "sent") continue;
        const current = await this.fetchCurrent(uuid, entry);
        if (!current) continue;
        drafts.push(
          this.toDraft(
            `${DRAFT_PREFIX}${uuid}`,
            { ...entry, revision: current.revision },
            current.raw,
            current.imapId
          )
        );
      }
      return { success: true, drafts };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getDraft(draftId: string): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      const entry = this.load().drafts[uuid];
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      const current = await this.fetchCurrent(uuid, entry);
      if (!current) {
        return {
          success: false,
          error: `Draft "${draftId}" no longer exists in the server Drafts mailbox.`,
        };
      }
      return {
        success: true,
        draft: this.toDraft(
          draftId,
          { ...entry, revision: current.revision },
          current.raw,
          current.imapId
        ),
        warning: entry.warning,
        smtpMessageId: entry.smtpMessageId,
        sentMessageId: entry.sentImapId,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Resolve a reply from server headers without writing or sending anything. */
  async previewReply(input: ImapReplyInput): Promise<ImapReplyPreviewResult> {
    try {
      const identity = this.identityFor(input.from);
      const account = this.imapAccountFor(identity);
      const ref = decodeImapId(input.originalMessageId);
      if (!ref || ref.account !== account || !Number.isSafeInteger(ref.uid) || ref.uid < 1) {
        throw new Error("Reply source must be a message in the selected IMAP account.");
      }
      const source = await imapFetchRawMessage(
        input.originalMessageId,
        this.depsForAccount(account)
      );
      if (!source) throw new Error("The original message was not found on the IMAP server.");
      const original = parseOriginalHeaders(source.raw.toString("utf8"));
      if (!original.messageId || !/^<[^<>\s]+@[^<>\s]+>$/.test(original.messageId)) {
        throw new Error(
          "The original message has no valid Message-ID; a threaded reply cannot be created."
        );
      }
      const decoded = parseDraftMime(source.raw);
      original.subject = decoded.subject;
      const self = [...this.selfAddresses, identity.email];
      const selfSet = new Set(self.map((address) => address.toLowerCase()));
      const sentBySelf =
        original.from.length > 0 &&
        original.from.every((address) => selfSet.has(address.toLowerCase()));
      const recipients = sentBySelf
        ? original.to
        : original.replyTo.length
          ? original.replyTo
          : original.from;
      original.replyTo = recipients.filter((address) => !selfSet.has(address.toLowerCase()));
      if (!original.replyTo.length)
        throw new Error("The original message has no non-self reply recipient.");
      const reply = buildReplyOptions({
        original,
        originalPlainText: input.quoteOriginal ? decoded.body : "",
        body: input.body,
        replyAll: input.replyAll ?? false,
        self,
        from: identity.email,
      });
      for (const address of [...reply.to, ...(reply.cc ?? [])]) {
        if (!z.string().email().safeParse(address).success)
          throw new Error("The original message contains an invalid reply address.");
      }
      // Message-ID values are case-sensitive. Preserve the parent's full chain.
      reply.references = [...new Set([...original.references, original.messageId])];
      if (reply.references.some((value) => !/^<[^<>\s]+@[^<>\s]+>$/.test(value))) {
        throw new Error("The original message contains invalid threading headers.");
      }
      return { success: true, reply };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async createReplyDraft(input: ImapReplyInput): Promise<ImapDraftResult> {
    const preview = await this.previewReply(input);
    if (!preview.success || !preview.reply) return { success: false, error: preview.error };
    return this.createDraft(preview.reply);
  }

  async createDraft(input: ImapDraftCreateInput): Promise<ImapDraftResult> {
    try {
      const identity = this.identityFor(input.from);
      const account = this.imapAccountFor(identity);
      const uuid = randomUUID();
      const raw = await composeDraftMime({
        draftUuid: uuid,
        from: identity.sender,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
        htmlBody: input.htmlBody,
        attachments: input.attachments,
        inReplyTo: input.inReplyTo,
        references: input.references,
      });
      const appended = await imapAppendRawMessage(
        raw,
        "drafts",
        { name: DRAFT_ID_HEADER, value: uuid },
        this.depsForAccount(account)
      );
      const verified = await imapFetchRawMessage(appended.id, this.depsForAccount(account));
      if (!verified) {
        throw new Error("Draft was appended, but its exact server copy could not be verified.");
      }
      const draftId = `${DRAFT_PREFIX}${uuid}`;
      const parsed = parseDraftMime(verified.raw);
      const entry: ImapDraftRegistryEntry = {
        imapId: appended.id,
        account,
        identityId: identity.identityId,
        fromEmail: identity.email,
        identitySender: identity.sender,
        identityAccountId: identity.accountId,
        identityAccountName: identity.accountName,
        revision: draftMimeRevision(verified.raw),
        messageId: parsed.messageId,
        updatedAt: new Date().toISOString(),
        state: "draft",
      };
      const registry = this.load();
      registry.drafts[uuid] = entry;
      this.save(registry);
      return {
        success: true,
        draft: this.toDraft(draftId, entry, verified.raw),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async updateDraft(draftId: string, update: ImapDraftUpdate): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      const registry = this.load();
      const entry = registry.drafts[uuid];
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      if (entry.state !== "draft") {
        return {
          success: false,
          error: `Draft "${draftId}" is ${entry.state} and cannot be edited automatically.`,
        };
      }
      const current = await this.fetchCurrent(uuid, entry);
      if (!current) {
        return { success: false, error: `Draft "${draftId}" was not found on the IMAP server.` };
      }
      if (update.expectedRevision && update.expectedRevision !== current.revision) {
        return {
          success: false,
          error: `Draft revision conflict: expected ${update.expectedRevision}, current revision is ${current.revision}. Read the draft again before editing.`,
        };
      }

      const parsed = parseDraftMime(current.raw);
      const identity = update.from ? this.identityFor(update.from) : this.identityForEntry(entry);
      const account = this.imapAccountFor(identity);
      const removeNames = new Set(update.attachmentNamesToRemove ?? []);
      const preserved: MimeDraftAttachment[] = parsed.attachments.filter(
        (attachment) => !removeNames.has(attachment.filename)
      );
      const nextRaw = await composeDraftMime({
        draftUuid: uuid,
        from: identity.sender,
        to: update.to ?? parsed.to,
        cc: update.cc ?? parsed.cc,
        bcc: update.bcc ?? parsed.bcc,
        subject: update.subject ?? parsed.subject,
        body: update.body ?? parsed.body,
        htmlBody: update.htmlBody === null ? undefined : (update.htmlBody ?? parsed.htmlBody),
        attachments: [...preserved, ...(update.attachmentsToAdd ?? [])],
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
      });
      const appended = await imapAppendRawMessage(
        nextRaw,
        "drafts",
        { name: DRAFT_ID_HEADER, value: uuid },
        this.depsForAccount(account)
      );
      const verified = await imapFetchRawMessage(appended.id, this.depsForAccount(account));
      if (!verified) {
        throw new Error(
          "Updated draft was appended, but its exact server copy could not be verified; the original was kept."
        );
      }

      const latestRegistry = this.load();
      const latest = latestRegistry.drafts[uuid];
      if (!latest || latest.imapId !== current.imapId) {
        await imapDeleteExactMessage(appended.id, this.depsForAccount(account)).catch(() => false);
        return {
          success: false,
          error: "Draft changed concurrently; the replacement was discarded. Read it again.",
        };
      }
      const nextParsed = parseDraftMime(verified.raw);
      const nextEntry: ImapDraftRegistryEntry = {
        ...latest,
        imapId: appended.id,
        account,
        identityId: identity.identityId,
        fromEmail: identity.email,
        identitySender: identity.sender,
        identityAccountId: identity.accountId,
        identityAccountName: identity.accountName,
        revision: draftMimeRevision(verified.raw),
        messageId: nextParsed.messageId,
        updatedAt: new Date().toISOString(),
        warning: undefined,
      };
      latestRegistry.drafts[uuid] = nextEntry;
      this.save(latestRegistry);

      let warning: string | undefined;
      const oldDeleted = await imapDeleteExactMessage(
        current.imapId,
        this.depsForAccount(entry.account)
      ).catch(() => false);
      if (!oldDeleted) {
        warning =
          "The updated draft is saved, but the older server copy could not be removed and may briefly appear as a duplicate.";
        const after = this.load();
        if (after.drafts[uuid]) after.drafts[uuid].warning = warning;
        this.save(after);
      }
      return {
        success: true,
        draft: this.toDraft(draftId, nextEntry, verified.raw),
        warning,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendDraft(draftId: string, expectedRevision?: string): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      let registry = this.load();
      const entry = registry.drafts[uuid];
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      if (entry.state === "sending" || entry.state === "needs_review") {
        return {
          success: false,
          error: `Draft "${draftId}" previously entered the sending state. It was not retried to avoid a duplicate; verify Sent before taking further action.`,
        };
      }
      if (entry.state === "sent") {
        return {
          success: true,
          smtpMessageId: entry.smtpMessageId,
          sentMessageId: entry.sentImapId,
          warning: "This draft was already sent; no second SMTP submission occurred.",
        };
      }
      const current = await this.fetchCurrent(uuid, entry);
      if (!current) {
        return { success: false, error: `Draft "${draftId}" was not found on the IMAP server.` };
      }
      if (expectedRevision && expectedRevision !== current.revision) {
        return {
          success: false,
          error: `Draft revision conflict: expected ${expectedRevision}, current revision is ${current.revision}. Read the draft again before sending.`,
        };
      }
      const parsed = parseDraftMime(current.raw);
      const recipients = [...parsed.to, ...parsed.cc, ...parsed.bcc];
      if (recipients.length === 0) {
        return { success: false, error: `Draft "${draftId}" has no recipients.` };
      }
      const identity = this.identityForEntry(entry);
      if (senderEmail(parsed.from) !== identity.email.toLowerCase()) {
        return {
          success: false,
          error: `Draft From changed to "${parsed.from}" and no longer matches its reviewed identity "${identity.email}".`,
        };
      }
      const config = this.smtpConfigResolver(identity);

      registry = this.load();
      if (registry.drafts[uuid]?.imapId !== current.imapId) {
        return {
          success: false,
          error: "Draft changed concurrently before send; read it again.",
        };
      }
      registry.drafts[uuid].state = "sending";
      registry.drafts[uuid].updatedAt = new Date().toISOString();
      this.save(registry);

      const deliverable = prepareDraftMimeForSend(current.raw);
      let sent: SmtpSendResult;
      try {
        sent = await this.smtpSend(
          deliverable,
          { from: identity.email, to: recipients.map(senderEmail) },
          config
        );
      } catch (error) {
        sent = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          uncertain: true,
        };
      }
      if (!sent.success) {
        registry = this.load();
        if (registry.drafts[uuid]?.state === "sending") {
          registry.drafts[uuid].state = sent.uncertain ? "needs_review" : "draft";
          registry.drafts[uuid].warning = sent.error;
          registry.drafts[uuid].updatedAt = new Date().toISOString();
          this.save(registry);
        }
        return {
          success: false,
          error: sent.uncertain
            ? `${sent.error ?? "SMTP outcome is uncertain."} Verify Sent before retrying.`
            : (sent.error ?? "SMTP send failed."),
        };
      }

      registry = this.load();
      if (registry.drafts[uuid]) {
        registry.drafts[uuid].state = "sent";
        registry.drafts[uuid].smtpMessageId = sent.messageId;
        registry.drafts[uuid].updatedAt = new Date().toISOString();
        this.save(registry);
      }

      const messageId = parsed.messageId;
      let sentCopy = messageId
        ? await imapFindRawMessageByHeader(
            "sent",
            { name: "Message-ID", value: messageId },
            this.depsForAccount(entry.account)
          ).catch(() => null)
        : null;
      for (let attempt = 0; !sentCopy && messageId && attempt < 2; attempt += 1) {
        await this.sleep(500);
        sentCopy = await imapFindRawMessageByHeader(
          "sent",
          { name: "Message-ID", value: messageId },
          this.depsForAccount(entry.account)
        ).catch(() => null);
      }

      let warning: string | undefined;
      if (!sentCopy && messageId) {
        sentCopy = await imapAppendRawMessage(
          deliverable,
          "sent",
          { name: "Message-ID", value: messageId },
          this.depsForAccount(entry.account)
        ).catch(() => null);
        if (!sentCopy) {
          warning =
            "SMTP accepted the message, but the connector could not verify or append its Sent copy.";
        }
      }
      const draftDeleted = await imapDeleteExactMessage(
        current.imapId,
        this.depsForAccount(entry.account)
      ).catch(() => false);
      if (!draftDeleted) {
        warning = warning
          ? `${warning} The original Drafts copy also could not be removed.`
          : "SMTP accepted the message, but the original Drafts copy could not be removed.";
      }
      registry = this.load();
      if (registry.drafts[uuid]) {
        registry.drafts[uuid].sentImapId = sentCopy?.id;
        registry.drafts[uuid].warning = warning;
        this.save(registry);
      }
      return {
        success: true,
        draft: this.toDraft(
          draftId,
          { ...entry, state: "sent", revision: current.revision },
          current.raw,
          current.imapId
        ),
        smtpMessageId: sent.messageId,
        sentMessageId: sentCopy?.id,
        warning,
      };
    } catch (error) {
      const uuid = draftUuid(draftId);
      try {
        const registry = this.load();
        if (registry.drafts[uuid]?.state === "sending") {
          registry.drafts[uuid].state = "needs_review";
          registry.drafts[uuid].warning =
            "Sending outcome is uncertain. Verify Sent before retrying.";
          this.save(registry);
        }
      } catch {
        // Preserve the original failure.
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async deleteDraft(draftId: string): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      const registry = this.load();
      const entry = registry.drafts[uuid];
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      if (entry.state === "sending") {
        return {
          success: false,
          error: `Draft "${draftId}" is sending and cannot be deleted safely.`,
        };
      }
      const current = await this.fetchCurrent(uuid, entry);
      const draft = current ? this.toDraft(draftId, entry, current.raw, current.imapId) : undefined;
      if (current) {
        const deleted = await imapDeleteExactMessage(
          current.imapId,
          this.depsForAccount(entry.account)
        );
        if (!deleted) {
          return { success: false, error: `IMAP server refused to delete draft "${draftId}".` };
        }
      }
      const latest = this.load();
      delete latest.drafts[uuid];
      this.save(latest);
      return { success: true, draft };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Manual recovery for an uncertain SMTP outcome. This never submits mail:
   * it only records the user's verified Sent/not-Sent decision.
   */
  async resolveUncertainSend(
    draftId: string,
    outcome: "sent" | "not_sent"
  ): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      let registry = this.load();
      const entry = registry.drafts[uuid];
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      if (entry.state !== "sending" && entry.state !== "needs_review") {
        return {
          success: false,
          error: `Draft "${draftId}" is ${entry.state}; no uncertain send needs resolution.`,
        };
      }
      if (outcome === "not_sent") {
        entry.state = "draft";
        entry.warning = undefined;
        entry.updatedAt = new Date().toISOString();
        this.save(registry);
        return this.getDraft(draftId);
      }

      const sentCopy = entry.messageId
        ? await imapFindRawMessageByHeader(
            "sent",
            { name: "Message-ID", value: entry.messageId },
            this.depsForAccount(entry.account)
          ).catch(() => null)
        : null;
      const current = await this.fetchCurrent(uuid, entry);
      if (current) {
        await imapDeleteExactMessage(current.imapId, this.depsForAccount(entry.account)).catch(
          () => false
        );
      }
      registry = this.load();
      if (registry.drafts[uuid]) {
        registry.drafts[uuid].state = "sent";
        registry.drafts[uuid].sentImapId = sentCopy?.id;
        registry.drafts[uuid].warning = sentCopy
          ? undefined
          : "Marked sent after manual verification; no matching IMAP Sent copy was found.";
        registry.drafts[uuid].updatedAt = new Date().toISOString();
        this.save(registry);
      }
      return {
        success: true,
        sentMessageId: sentCopy?.id ?? entry.sentImapId,
        warning: registry.drafts[uuid]?.warning,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
