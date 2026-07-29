/**
 * Gmail-like draft and sending-identity resources for Mail.app.
 *
 * Mail exposes saved drafts as ordinary messages inside each account's Drafts
 * mailbox. `every outgoing message` only contains active compose sessions and
 * is often empty even when Mail.app visibly has saved drafts. This manager
 * indexes the real Drafts mailboxes, assigns opaque UUID draft ids in a small
 * local registry, and rebinds them by fingerprint when Mail changes a native
 * message id.
 */
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { AttachmentInput, Draft, SendingIdentity } from "@/types.js";
import { executeAppleScript } from "@/utils/applescript.js";
import { materializeAttachments } from "@/utils/attachmentMaterialize.js";
import {
  buildAttachmentCommands,
  escapeForAppleScript,
  escapeForAppleScriptBody,
} from "@/services/appleMailManager.js";

// Mail's compose bridge intermittently throws "Internal error" when a list of
// rich-text draft bodies is coerced using literal ASCII record separators.
// Use long printable sentinels for this draft-only transport instead.
const FIELD_SEP = "\u241fAPPLE_MAIL_DRAFT_FIELD\u241f";
const RECORD_SEP = "\u241eAPPLE_MAIL_DRAFT_RECORD\u241e";
const ADDRESS_SEP = "\u241dAPPLE_MAIL_DRAFT_ADDRESS\u241d";
const DRAFT_ID_PREFIX = "apple-draft:";

export const DRAFT_ID_PATTERN = /^apple-draft:[0-9a-f-]{36}$/i;

type ScriptExecutor = typeof executeAppleScript;

interface NativeDraft {
  nativeId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  visible: boolean;
  sourceKind: "compose" | "mailbox";
  accountId?: string;
  accountName?: string;
  mailboxName?: string;
  messageId?: string;
  hasAttachments: boolean;
}

interface RegistryEntry {
  nativeId: string;
  locator?: string;
  fingerprint: string;
  updatedAt: string;
}

interface DraftRegistry {
  version: 1;
  defaultIdentityId?: string;
  drafts: Record<string, RegistryEntry>;
  /** Fingerprints Mail's compose backend still exposes after discard/send. */
  discardedFingerprints?: Record<string, string>;
  /** Stable saved-message locators confirmed to back a discarded compose draft. */
  discardedLocators?: Record<string, string>;
}

export interface DraftManagerOptions {
  registryPath?: string;
  execute?: ScriptExecutor;
}

export interface DraftUpdate {
  /** Reject the mutation when the saved draft changed after it was reviewed. */
  expectedRevision?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}

export interface CreateDraftInput {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: AttachmentInput[];
}

export interface DraftResult {
  success: boolean;
  draft?: Draft;
  error?: string;
}

function registryPathDefault(): string {
  return join(homedir(), "Library", "Application Support", "apple-mail-mcp", "draft-registry.json");
}

function formattedSender(fullName: string, email: string): string {
  return fullName.trim() ? `${fullName.trim()} <${email.trim()}>` : email.trim();
}

function addressOnly(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return (match ? match[1] : sender).trim().toLowerCase();
}

function identityId(accountId: string, email: string): string {
  return `mail-identity:${createHash("sha256")
    .update(`${accountId}\0${email.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function splitAddresses(value: string): string[] {
  if (!value) return [];
  return value
    .split(ADDRESS_SEP)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNativeDraftRow(row: string): NativeDraft | null {
  const fields = row.split(FIELD_SEP);
  if (fields.length < 9) return null;
  return {
    nativeId: fields[0],
    from: fields[1],
    subject: fields[2],
    body: fields[3],
    visible: fields[4] === "true",
    to: splitAddresses(fields[5]),
    cc: splitAddresses(fields[6]),
    bcc: splitAddresses(fields[7]),
    sourceKind: fields[8] === "mailbox" ? "mailbox" : "compose",
    accountId: fields[9] || undefined,
    accountName: fields[10] || undefined,
    mailboxName: fields[11] || undefined,
    messageId: fields[12] || undefined,
    hasAttachments: fields[13] === "true",
  };
}

function fingerprintWithBody(
  draft: Pick<Draft, "from" | "to" | "cc" | "bcc" | "subject">,
  body: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        from: addressOnly(draft.from),
        to: draft.to.map((value) => value.trim().toLowerCase()),
        cc: draft.cc.map((value) => value.trim().toLowerCase()),
        bcc: draft.bcc.map((value) => value.trim().toLowerCase()),
        subject: draft.subject.trimEnd(),
        body,
      })
    )
    .digest("hex");
}

function normalizedBody(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function legacyNormalizedBody(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
}

function fingerprint(
  draft: Pick<Draft, "from" | "to" | "cc" | "bcc" | "subject" | "body">
): string {
  return fingerprintWithBody(draft, normalizedBody(draft.body));
}

/** Stable digest of every reviewed field that affects a scheduled send. */
export function draftContentFingerprint(
  draft: Pick<Draft, "from" | "to" | "cc" | "bcc" | "subject" | "body">
): string {
  return fingerprintWithBody(draft, normalizedBody(draft.body));
}

function fingerprintVariants(draft: NativeDraft): string[] {
  return [
    ...new Set([
      fingerprintWithBody(draft, normalizedBody(draft.body)),
      fingerprintWithBody(draft, legacyNormalizedBody(draft.body)),
    ]),
  ];
}

function sameBody(left: string, right: string): boolean {
  return normalizedBody(left) === normalizedBody(right);
}

function draftIdFromUuid(uuid: string): string {
  return `${DRAFT_ID_PREFIX}${uuid}`;
}

function nativeLocator(
  draft: Pick<Draft, "sourceKind" | "accountId" | "mailboxName" | "messageId" | "nativeId">
): string {
  return draft.sourceKind === "mailbox"
    ? [
        "mailbox",
        draft.accountId ?? "",
        draft.mailboxName ?? "",
        draft.messageId ? "message-id" : "native-id",
        draft.messageId ?? draft.nativeId,
      ].join("\0")
    : `compose\0${draft.nativeId}`;
}

function uuidFromDraftId(draftId: string): string | null {
  return DRAFT_ID_PATTERN.test(draftId) ? draftId.slice(DRAFT_ID_PREFIX.length) : null;
}

function serializeRecipientList(
  variableName: string,
  kind: "to" | "cc" | "bcc",
  prefix: string
): string {
  return `
    set ${prefix}Addresses to {}
    repeat with recipientItem in ${kind} recipients of ${variableName}
      try
        set concreteRecipient to get recipientItem
        set recipientAddress to (address of concreteRecipient) as text
        set end of ${prefix}Addresses to recipientAddress
      end try
    end repeat
    set oldDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to "${ADDRESS_SEP}"
    set ${prefix}Joined to ${prefix}Addresses as text
    set AppleScript's text item delimiters to oldDelimiters
  `;
}

function serializeDraftExpression(
  variableName: string,
  source:
    | { kind: "compose" }
    | {
        kind: "mailbox";
        accountIdVariable: string;
        accountNameVariable: string;
        mailboxNameVariable: string;
      } = { kind: "compose" }
): string {
  const sourceFields =
    source.kind === "mailbox"
      ? `"mailbox" & "${FIELD_SEP}" & ¬
      ${source.accountIdVariable} & "${FIELD_SEP}" & ¬
      ${source.accountNameVariable} & "${FIELD_SEP}" & ¬
      ${source.mailboxNameVariable} & "${FIELD_SEP}" & ¬
      draftMessageId & "${FIELD_SEP}" & ¬
      hasAttachments & "${FIELD_SEP}"`
      : `"compose" & "${FIELD_SEP}" & ¬
      "" & "${FIELD_SEP}" & ¬
      "" & "${FIELD_SEP}" & ¬
      "" & "${FIELD_SEP}" & ¬
      "" & "${FIELD_SEP}" & ¬
      hasAttachments & "${FIELD_SEP}"`;
  return `
    ${serializeRecipientList(variableName, "to", "to")}
    ${serializeRecipientList(variableName, "cc", "cc")}
    ${serializeRecipientList(variableName, "bcc", "bcc")}
    set hasAttachments to "false"
    try
      if (count of mail attachments of ${variableName}) > 0 then set hasAttachments to "true"
    end try
    set draftMessageId to ""
    try
      set draftMessageId to message id of ${variableName} as text
    end try
    set rowText to ((id of ${variableName}) as text) & "${FIELD_SEP}" & ¬
      (sender of ${variableName} as text) & "${FIELD_SEP}" & ¬
      (subject of ${variableName} as text) & "${FIELD_SEP}" & ¬
      (content of ${variableName} as text) & "${FIELD_SEP}" & ¬
      ${source.kind === "compose" ? `((visible of ${variableName}) as text)` : `"false"`} & "${FIELD_SEP}" & ¬
      toJoined & "${FIELD_SEP}" & ¬
      ccJoined & "${FIELD_SEP}" & ¬
      bccJoined & "${FIELD_SEP}" & ¬
      ${sourceFields}
  `;
}

function recipientCommands(kind: "to" | "cc" | "bcc", addresses: string[]): string {
  return addresses
    .map(
      (address) =>
        `make new ${kind} recipient at end of ${kind} recipients with properties {address:"${escapeForAppleScript(address)}"}`
    )
    .join("\n");
}

function replaceRecipients(kind: "to" | "cc" | "bcc", addresses: string[]): string {
  return `
    repeat while (count of ${kind} recipients of draftMessage) > 0
      delete item 1 of ${kind} recipients of draftMessage
    end repeat
    ${recipientCommands(kind, addresses)}
  `;
}

/** Build the read-only AppleScript used by list-drafts. Exported for tests/debugging. */
export function buildListDraftsAppleScript(): string {
  return `
    tell application "Mail"
      set draftRows to {}
      repeat with accountItem in every account
        set concreteAccount to get accountItem
        set accountIdText to id of concreteAccount as text
        set accountNameText to name of concreteAccount as text
        repeat with mailboxItem in mailboxes of concreteAccount
          set concreteMailbox to get mailboxItem
          set mailboxNameText to name of concreteMailbox as text
          ignoring case
            set isDraftMailbox to mailboxNameText is "Drafts" or mailboxNameText is "Draft"
          end ignoring
          if isDraftMailbox then
            repeat with messageItem in messages of concreteMailbox
              try
                set draftMessage to get messageItem
                ${serializeDraftExpression("draftMessage", {
                  kind: "mailbox",
                  accountIdVariable: "accountIdText",
                  accountNameVariable: "accountNameText",
                  mailboxNameVariable: "mailboxNameText",
                })}
                set end of draftRows to rowText
              end try
            end repeat
          end if
        end repeat
      end repeat
      set AppleScript's text item delimiters to "${RECORD_SEP}"
      return draftRows as text
    end tell
  `;
}

export class DraftManager {
  private readonly registryPath: string;
  private readonly execute: ScriptExecutor;

  constructor(options: DraftManagerOptions = {}) {
    this.registryPath = options.registryPath ?? registryPathDefault();
    this.execute = options.execute ?? executeAppleScript;
  }

  private loadRegistry(): DraftRegistry {
    try {
      if (!existsSync(this.registryPath)) return { version: 1, drafts: {} };
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as Partial<DraftRegistry>;
      if (parsed.version !== 1 || !parsed.drafts || typeof parsed.drafts !== "object") {
        return { version: 1, drafts: {} };
      }
      return parsed as DraftRegistry;
    } catch {
      return { version: 1, drafts: {} };
    }
  }

  private saveRegistry(registry: DraftRegistry): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, this.registryPath);
  }

  listSendingIdentities(): SendingIdentity[] {
    const script = `
      tell application "Mail"
        set defaultSender to ""
        try
          set probeMessage to make new outgoing message
          set defaultSender to sender of probeMessage as text
          delete probeMessage
        end try
        set identityRows to {}
        repeat with accountItem in every account
          set concreteAccount to get accountItem
          set accountId to id of concreteAccount as text
          set accountName to name of concreteAccount as text
          set accountFullName to full name of concreteAccount as text
          set accountEnabled to enabled of concreteAccount as text
          set configuredAddresses to get email addresses of concreteAccount
          repeat with addressItem in configuredAddresses
            set concreteAddress to get addressItem
            set emailAddress to concreteAddress as text
            set end of identityRows to accountId & "${FIELD_SEP}" & accountName & "${FIELD_SEP}" & accountFullName & "${FIELD_SEP}" & emailAddress & "${FIELD_SEP}" & accountEnabled & "${FIELD_SEP}" & defaultSender
          end repeat
        end repeat
        set AppleScript's text item delimiters to "${RECORD_SEP}"
        return identityRows as text
      end tell
    `;
    const result = this.execute(script);
    if (!result.success || !result.output.trim()) return [];

    return result.output
      .split(RECORD_SEP)
      .map((row): SendingIdentity | null => {
        const [accountId, accountName, fullName, email, enabled, defaultSender] =
          row.split(FIELD_SEP);
        if (!accountId || !email) return null;
        return {
          identityId: identityId(accountId, email),
          accountId,
          accountName,
          email,
          fullName: fullName ?? "",
          sender: formattedSender(fullName ?? "", email),
          enabled: enabled === "true",
          isDefault: addressOnly(defaultSender ?? "") === email.trim().toLowerCase(),
        };
      })
      .filter((item): item is SendingIdentity => item !== null);
  }

  getDefaultIdentity(): SendingIdentity | null {
    const identities = this.listSendingIdentities();
    const registry = this.loadRegistry();
    if (registry.defaultIdentityId) {
      const preferred = identities.find(
        (identity) => identity.identityId === registry.defaultIdentityId && identity.enabled
      );
      if (preferred) return preferred;
    }
    return identities.find((identity) => identity.isDefault && identity.enabled) ?? null;
  }

  setDefaultIdentity(identitySelector: string): SendingIdentity | null {
    const selector = identitySelector.trim().toLowerCase();
    const identities = this.listSendingIdentities();
    const matches = identities.filter(
      (identity) =>
        identity.identityId.toLowerCase() === selector ||
        identity.email.toLowerCase() === selector ||
        identity.sender.toLowerCase() === selector
    );
    if (matches.length !== 1 || !matches[0].enabled) return null;
    const registry = this.loadRegistry();
    registry.defaultIdentityId = matches[0].identityId;
    this.saveRegistry(registry);
    return matches[0];
  }

  resolveIdentity(selector?: string): SendingIdentity | null {
    if (!selector) return this.getDefaultIdentity();
    const normalized = selector.trim().toLowerCase();
    const identities = this.listSendingIdentities();
    const accountMatches = identities.filter(
      (identity) => identity.accountName.toLowerCase() === normalized && identity.enabled
    );
    if (accountMatches.length > 0) {
      return accountMatches.find((identity) => identity.isDefault) ?? accountMatches[0];
    }
    const matches = identities.filter(
      (identity) =>
        identity.identityId.toLowerCase() === normalized ||
        identity.email.toLowerCase() === normalized ||
        identity.sender.toLowerCase() === normalized
    );
    return matches.length === 1 && matches[0].enabled ? matches[0] : null;
  }

  private listNativeDrafts(): { drafts: NativeDraft[]; error?: string } {
    const script = buildListDraftsAppleScript();
    const result = this.execute(script, { timeoutMs: 60000 });
    if (!result.success) return { drafts: [], error: result.error ?? "Failed to list drafts" };
    if (!result.output.trim()) return { drafts: [] };
    return {
      drafts: result.output
        .split(RECORD_SEP)
        .map(parseNativeDraftRow)
        .filter((draft): draft is NativeDraft => draft !== null),
    };
  }

  private syncRegistry(nativeDrafts: NativeDraft[]): Draft[] {
    const registry = this.loadRegistry();
    const discarded = registry.discardedFingerprints ?? {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [fp, at] of Object.entries(discarded)) {
      if (new Date(at).getTime() < cutoff) delete discarded[fp];
    }
    registry.discardedFingerprints = discarded;
    const discardedLocators = registry.discardedLocators ?? {};
    const liveLocators = new Set(nativeDrafts.map(nativeLocator));
    for (const locator of Object.keys(discardedLocators)) {
      if (!liveLocators.has(locator)) delete discardedLocators[locator];
    }
    registry.discardedLocators = discardedLocators;
    const unmatched = new Set(Object.keys(registry.drafts));
    const output: Draft[] = [];

    for (const native of nativeDrafts) {
      const fp = fingerprint(native);
      const variants = fingerprintVariants(native);
      const locator = nativeLocator(native);
      if (discardedLocators[locator]) continue;
      if (variants.some((candidate) => discarded[candidate])) {
        if (native.sourceKind === "mailbox") {
          discardedLocators[locator] = new Date().toISOString();
        }
        continue;
      }
      // A locator/native-id match identifies the resource. The fingerprint is
      // its revision, not its identity: Mail.app/iPhone edits must keep the same
      // public draft_id while producing a new revision.
      let uuid = [...unmatched].find((candidate) => {
        const entry = registry.drafts[candidate];
        return entry.locator === nativeLocator(native) || entry.nativeId === native.nativeId;
      });
      if (!uuid) {
        uuid = [...unmatched].find((candidate) =>
          variants.includes(registry.drafts[candidate].fingerprint)
        );
      }
      if (!uuid) uuid = randomUUID();
      unmatched.delete(uuid);
      registry.drafts[uuid] = {
        nativeId: native.nativeId,
        locator: nativeLocator(native),
        fingerprint: fp,
        updatedAt: new Date().toISOString(),
      };
      output.push({ draftId: draftIdFromUuid(uuid), revision: fp, ...native });
    }

    for (const stale of unmatched) delete registry.drafts[stale];
    this.saveRegistry(registry);
    return output;
  }

  listDrafts(): DraftResult & { drafts?: Draft[] } {
    const native = this.listNativeDrafts();
    if (native.error) return { success: false, error: native.error };
    return { success: true, drafts: this.syncRegistry(native.drafts) };
  }

  getDraft(draftId: string): DraftResult {
    const listed = this.listDrafts();
    if (!listed.success) return listed;
    const draft = listed.drafts?.find((item) => item.draftId === draftId);
    return draft
      ? { success: true, draft }
      : { success: false, error: `Draft "${draftId}" was not found. List drafts again.` };
  }

  private createNativeDraft(input: Omit<CreateDraftInput, "from"> & { sender?: string }): {
    success: boolean;
    draft?: NativeDraft;
    error?: string;
  } {
    const mat = materializeAttachments(input.attachments);
    try {
      const script = `
        tell application "Mail"
          set draftMessage to make new outgoing message with properties {subject:"${escapeForAppleScript(input.subject)}", content:"${escapeForAppleScriptBody(input.body)}", visible:false}
          tell draftMessage
            ${recipientCommands("to", input.to)}
            ${recipientCommands("cc", input.cc ?? [])}
            ${recipientCommands("bcc", input.bcc ?? [])}
            ${input.sender ? `set sender to "${escapeForAppleScript(input.sender)}"` : ""}
            ${buildAttachmentCommands(mat.paths)}
          end tell
          save draftMessage
          ${serializeDraftExpression("draftMessage")}
          return rowText
        end tell
      `;
      const result = this.execute(script, { timeoutMs: 60000, maxRetries: 2 });
      if (!result.success) {
        return { success: false, error: result.error ?? "Failed to create draft" };
      }
      const native = parseNativeDraftRow(result.output);
      if (!native)
        return { success: false, error: "Mail created the draft but returned no handle." };
      return { success: true, draft: native };
    } finally {
      mat.cleanup();
    }
  }

  createDraft(input: CreateDraftInput): DraftResult {
    const identity = this.resolveIdentity(input.from);
    if (input.from && !identity) {
      return {
        success: false,
        error: `Sending identity "${input.from}" is unavailable or ambiguous. List sending identities first.`,
      };
    }
    const created = this.createNativeDraft({
      ...input,
      sender: identity?.sender,
    });
    if (!created.success || !created.draft) {
      return { success: false, error: created.error ?? "Failed to create draft." };
    }
    const native = created.draft;
    try {
      const listed = this.listNativeDrafts();
      const draftsToSync = listed.drafts.some(
        (item) => item.nativeId === native.nativeId && fingerprint(item) === fingerprint(native)
      )
        ? listed.drafts
        : [...listed.drafts, native];
      const draft = this.syncRegistry(draftsToSync).find(
        (item) => item.nativeId === native.nativeId && fingerprint(item) === fingerprint(native)
      );
      return draft
        ? { success: true, draft }
        : { success: false, error: "Draft created but could not be registered." };
    } catch (error) {
      return {
        success: false,
        error: `Draft created but registration failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  updateDraft(draftId: string, update: DraftUpdate): DraftResult {
    const uuid = uuidFromDraftId(draftId);
    if (!uuid) return { success: false, error: `Invalid draft id "${draftId}".` };
    const current = this.getDraft(draftId);
    if (!current.success || !current.draft) return current;
    if (
      update.expectedRevision !== undefined &&
      update.expectedRevision !== current.draft.revision
    ) {
      return {
        success: false,
        error: `Draft conflict: expected revision "${update.expectedRevision}", but the current revision is "${current.draft.revision}". Read the draft again before editing.`,
      };
    }

    let sender: string | undefined;
    if (update.from !== undefined) {
      const identity = this.resolveIdentity(update.from);
      if (!identity) {
        return {
          success: false,
          error: `Sending identity "${update.from}" is unavailable or ambiguous.`,
        };
      }
      sender = identity.sender;
    }

    // Saved Drafts-mailbox messages are read-only through Mail's scripting
    // bridge, and Mail also silently ignores `set content` on many live saved
    // compose objects. Recreate-and-swap is the only reliable edit path. Create
    // and verify the replacement first; only then discard the exact old mailbox
    // message and rebind the SAME stable plugin draft id.
    if (update.body !== undefined || current.draft.sourceKind === "mailbox") {
      if (current.draft.hasAttachments) {
        return {
          success: false,
          error:
            "This draft has attachments. Mail.app cannot safely recreate it through AppleScript without changing its MIME structure; edit it in Mail.app.",
        };
      }
      const desired: NativeDraft = {
        nativeId: current.draft.nativeId,
        from: sender ?? current.draft.from,
        to: update.to ?? current.draft.to,
        cc: update.cc ?? current.draft.cc,
        bcc: update.bcc ?? current.draft.bcc,
        subject: update.subject ?? current.draft.subject,
        body: update.body ?? current.draft.body,
        visible: false,
        sourceKind: "compose",
        hasAttachments: false,
      };
      const replacement = this.createNativeDraft({
        sender: desired.from,
        to: desired.to,
        cc: desired.cc,
        bcc: desired.bcc,
        subject: desired.subject,
        body: desired.body,
      });
      if (!replacement.success || !replacement.draft) {
        return {
          success: false,
          error: `Original draft was preserved because replacement creation failed: ${replacement.error ?? "unknown error"}`,
        };
      }
      const actual = replacement.draft;
      const verified =
        addressOnly(actual.from) === addressOnly(desired.from) &&
        actual.subject.trimEnd() === desired.subject.trimEnd() &&
        sameBody(actual.body, desired.body) &&
        JSON.stringify(actual.to) === JSON.stringify(desired.to) &&
        JSON.stringify(actual.cc) === JSON.stringify(desired.cc) &&
        JSON.stringify(actual.bcc) === JSON.stringify(desired.bcc);
      if (!verified) {
        return {
          success: false,
          error:
            "Original draft was preserved because Mail did not reproduce the requested replacement exactly. The replacement draft was left for manual inspection.",
        };
      }

      const discarded = this.discardNativeDraft(current.draft);
      if (!discarded.success) {
        return {
          success: false,
          error: `Replacement was verified, but the original draft could not be removed: ${discarded.error}`,
        };
      }
      const registry = this.loadRegistry();
      if (
        current.draft.sourceKind === "compose" &&
        fingerprint(current.draft) !== fingerprint(actual)
      ) {
        registry.discardedFingerprints ??= {};
        registry.discardedFingerprints[fingerprint(current.draft)] = new Date().toISOString();
      }
      // Remove any temporary registry id assigned if list-drafts ran while the
      // replacement existed, then bind the original UUID to the replacement.
      for (const [candidate, entry] of Object.entries(registry.drafts)) {
        if (candidate !== uuid && entry.fingerprint === fingerprint(actual)) {
          delete registry.drafts[candidate];
        }
      }
      registry.drafts[uuid] = {
        nativeId: actual.nativeId,
        locator: nativeLocator(actual),
        fingerprint: fingerprint(actual),
        updatedAt: new Date().toISOString(),
      };
      this.saveRegistry(registry);
      return {
        success: true,
        draft: { draftId, revision: fingerprint(actual), ...actual },
      };
    }

    const commands = [
      update.subject !== undefined
        ? `set subject of draftMessage to "${escapeForAppleScript(update.subject)}"`
        : "",
      update.body !== undefined
        ? `set content of draftMessage to "${escapeForAppleScriptBody(update.body)}"`
        : "",
      sender !== undefined ? `set sender of draftMessage to "${escapeForAppleScript(sender)}"` : "",
      update.to !== undefined ? replaceRecipients("to", update.to) : "",
      update.cc !== undefined ? replaceRecipients("cc", update.cc) : "",
      update.bcc !== undefined ? replaceRecipients("bcc", update.bcc) : "",
    ].filter(Boolean);

    const script = `
      tell application "Mail"
        try
          set draftMessage to first outgoing message whose id is ${Number(current.draft.nativeId)}
        on error
          return "error:Draft is no longer available; list drafts again."
        end try
        ${commands.join("\n")}
        save draftMessage
        ${serializeDraftExpression("draftMessage")}
        return rowText
      end tell
    `;
    const result = this.execute(script, { timeoutMs: 60000 });
    if (!result.success || result.output.startsWith("error:")) {
      return {
        success: false,
        error: result.output.replace(/^error:/, "") || result.error || "Failed to update draft",
      };
    }
    const native = parseNativeDraftRow(result.output);
    if (!native) return { success: false, error: "Mail updated the draft but returned no handle." };

    const registry = this.loadRegistry();
    registry.drafts[uuid] = {
      nativeId: native.nativeId,
      locator: nativeLocator(native),
      fingerprint: fingerprint(native),
      updatedAt: new Date().toISOString(),
    };
    this.saveRegistry(registry);
    return {
      success: true,
      draft: { draftId, revision: fingerprint(native), ...native },
    };
  }

  sendDraft(draftId: string, expectedRevision?: string): DraftResult {
    const uuid = uuidFromDraftId(draftId);
    if (!uuid) return { success: false, error: `Invalid draft id "${draftId}".` };
    const current = this.getDraft(draftId);
    if (!current.success || !current.draft) return current;
    if (expectedRevision !== undefined && expectedRevision !== current.draft.revision) {
      return {
        success: false,
        error: `Draft conflict: expected revision "${expectedRevision}", but the current revision is "${current.draft.revision}". Read the draft again before sending.`,
      };
    }
    if (current.draft.sourceKind === "mailbox" && current.draft.hasAttachments) {
      return {
        success: false,
        error:
          "This saved draft has attachments. Send it from Mail.app so its original MIME structure is preserved.",
      };
    }
    const script =
      current.draft.sourceKind === "mailbox"
        ? `
      tell application "Mail"
        try
          set draftMessage to make new outgoing message with properties {subject:"${escapeForAppleScript(current.draft.subject)}", content:"${escapeForAppleScriptBody(current.draft.body)}", visible:false}
          tell draftMessage
            ${recipientCommands("to", current.draft.to)}
            ${recipientCommands("cc", current.draft.cc)}
            ${recipientCommands("bcc", current.draft.bcc)}
            set sender to "${escapeForAppleScript(current.draft.from)}"
          end tell
          send draftMessage
          return "sent"
        on error errMsg
          return "error:" & errMsg
        end try
      end tell
    `
        : `
      tell application "Mail"
        try
          set draftMessage to first outgoing message whose id is ${Number(current.draft.nativeId)}
          send draftMessage
          return "sent"
        on error errMsg
          return "error:" & errMsg
        end try
      end tell
    `;
    const result = this.execute(script, { timeoutMs: 60000 });
    if (!result.success || result.output !== "sent") {
      return {
        success: false,
        error: result.output.replace(/^error:/, "") || result.error || "Failed to send draft",
      };
    }
    if (current.draft.sourceKind === "mailbox") {
      // Sending a reconstructed compose message does not remove the original
      // saved mailbox draft, so delete that exact backing message only after
      // Mail confirms the send succeeded.
      this.discardNativeDraft(current.draft);
    }
    const registry = this.loadRegistry();
    if (current.draft.sourceKind === "compose") {
      registry.discardedFingerprints ??= {};
      registry.discardedFingerprints[fingerprint(current.draft)] = new Date().toISOString();
    }
    delete registry.drafts[uuid];
    this.saveRegistry(registry);
    return { success: true, draft: current.draft };
  }

  private discardNativeDraft(draft: Draft | NativeDraft): { success: boolean; error?: string } {
    if (draft.sourceKind === "mailbox" && draft.accountId && draft.mailboxName) {
      const script = `
        tell application "Mail"
          set targetMatches to {}
          repeat with accountItem in every account
            set concreteAccount to get accountItem
            if (id of concreteAccount as text) is "${escapeForAppleScript(draft.accountId)}" then
              repeat with mailboxItem in mailboxes of concreteAccount
                set concreteMailbox to get mailboxItem
                set mailboxName to name of concreteMailbox as text
                if mailboxName is "${escapeForAppleScript(draft.mailboxName)}" then
                  try
                    set idMatches to messages of concreteMailbox whose id is ${Number(draft.nativeId)}
                    repeat with messageItem in idMatches
                      set end of targetMatches to get messageItem
                    end repeat
                  end try
                end if
              end repeat
            end if
          end repeat
          if (count of targetMatches) is 1 then
            try
              delete item 1 of targetMatches
              return "backing-deleted"
            on error errMsg
              return "error:" & errMsg
            end try
          else if (count of targetMatches) > 1 then
            return "error:Multiple saved drafts matched the same locator; refusing deletion."
          end if
          return "error:Saved draft backing message was not found."
        end tell
      `;
      const result = this.execute(script, { timeoutMs: 60000 });
      if (!result.success || result.output.startsWith("error:")) {
        return {
          success: false,
          error:
            result.output.replace(/^error:/, "") || result.error || "Failed to delete saved draft",
        };
      }
      return { success: true };
    }

    // First discard the live compose object. Mail may keep a stale compose
    // backend object until restart even after the backing Drafts message moves
    // to Trash, so the registry tombstone below prevents it from resurfacing.
    const script = `
      tell application "Mail"
        set discardResult to "not-found"
        try
          set draftMessage to first outgoing message whose id is ${Number(draft.nativeId)}
          try
            close draftMessage saving no
          end try
          try
            delete draftMessage
          end try
          set discardResult to "discarded"
        end try

        -- Delete only an exact, unique backing Drafts message. Refuse an
        -- ambiguous match instead of risking deletion of a sibling draft.
        set backingMatches to {}
        repeat with accountItem in every account
          set concreteAccount to get accountItem
          repeat with mailboxItem in mailboxes of concreteAccount
            set concreteMailbox to get mailboxItem
            set mailboxName to name of concreteMailbox as text
            if mailboxName is "Drafts" or mailboxName is "DRAFTS" or mailboxName is "drafts" or mailboxName is "Draft" then
              try
                set subjectMatches to every message of concreteMailbox whose subject is "${escapeForAppleScript(draft.subject)}"
                repeat with messageItem in subjectMatches
                  set concreteMessage to get messageItem
                  try
                    if (sender of concreteMessage as text) is "${escapeForAppleScript(draft.from)}" and (content of concreteMessage as text) is "${escapeForAppleScriptBody(draft.body)}" then
                      set end of backingMatches to concreteMessage
                    end if
                  end try
                end repeat
              end try
            end if
          end repeat
        end repeat
        if (count of backingMatches) is 1 then
          try
            delete item 1 of backingMatches
            return discardResult & "|backing-deleted"
          on error errMsg
            return "error:" & errMsg
          end try
        else if (count of backingMatches) > 1 then
          return "error:Multiple identical backing drafts found; refusing ambiguous deletion."
        end if
        return discardResult & "|backing-not-found"
      end tell
    `;
    const result = this.execute(script, { timeoutMs: 60000 });
    if (!result.success || result.output.startsWith("error:")) {
      return {
        success: false,
        error: result.output.replace(/^error:/, "") || result.error || "Failed to delete draft",
      };
    }
    return { success: true };
  }

  deleteDraft(draftId: string): DraftResult {
    const uuid = uuidFromDraftId(draftId);
    if (!uuid) return { success: false, error: `Invalid draft id "${draftId}".` };
    const current = this.getDraft(draftId);
    if (!current.success || !current.draft) return current;
    const draft = current.draft;
    const discarded = this.discardNativeDraft(draft);
    if (!discarded.success) return discarded;

    const registry = this.loadRegistry();
    if (draft.sourceKind === "compose") {
      registry.discardedFingerprints ??= {};
      registry.discardedFingerprints[fingerprint(draft)] = new Date().toISOString();
    }
    delete registry.drafts[uuid];
    this.saveRegistry(registry);
    return { success: true, draft };
  }
}
