#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/schedulerCli.ts
import { realpathSync as realpathSync2 } from "fs";
import { fileURLToPath } from "url";

// src/services/scheduledSendManager.ts
import { randomUUID as randomUUID2 } from "crypto";
import {
  closeSync,
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync3,
  renameSync as renameSync3,
  statSync,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync4
} from "fs";
import { homedir as homedir3 } from "os";
import { dirname as dirname2, join as join4 } from "path";

// src/services/draftManager.ts
import { createHash, randomUUID } from "crypto";
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "fs";
import { homedir as homedir2 } from "os";
import { dirname, join as join3 } from "path";

// src/utils/applescript.ts
import { execSync, spawnSync } from "child_process";
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
function getMaxBuffer() {
  const raw = process.env.APPLE_MAIL_MCP_MAX_BUFFER;
  if (raw !== void 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_BUFFER_BYTES;
}
var DEFAULT_MAX_RETRIES = 1;
var DEFAULT_RETRY_DELAY_MS = 1e3;
var isDebugEnabled = () => {
  const debug = process.env.DEBUG;
  const verbose = process.env.VERBOSE;
  return debug === "1" || debug === "true" || verbose === "1" || verbose === "true";
};
function debugLog(message, data) {
  if (!isDebugEnabled()) return;
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  if (data !== void 0) {
    console.error(`[DEBUG ${timestamp}] ${message}`, data);
  } else {
    console.error(`[DEBUG ${timestamp}] ${message}`);
  }
}
function escapeForShell(script) {
  return script.replace(/'/g, "'\\''");
}
var SCRIPT_TIMEOUT_HEADROOM_MS = 5e3;
function wrapWithTimeout(script, processTimeoutMs) {
  const seconds = Math.max(1, Math.ceil((processTimeoutMs - SCRIPT_TIMEOUT_HEADROOM_MS) / 1e3));
  return `with timeout of ${seconds} seconds
${script}
end timeout`;
}
function isTimeoutError(error) {
  if (error instanceof Error) {
    const execError = error;
    return execError.killed === true || execError.signal === "SIGTERM" || execError.signal === "SIGKILL";
  }
  return false;
}
var RETRYABLE_ERROR_PATTERNS = [
  /timed? out/i,
  /not responding/i,
  /connection.*invalid/i,
  /lost connection/i,
  /busy/i
];
function isRetryableError(errorMessage) {
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}
function sleep(ms) {
  const seconds = ms / 1e3;
  const result = spawnSync("sleep", [seconds.toString()], { stdio: "ignore" });
  if (result.error) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
var ERROR_MAPPINGS = [
  // Permission errors
  {
    pattern: /not authorized|not permitted|access.*denied/i,
    message: "Permission denied. Grant automation access in System Settings > Privacy & Security > Automation."
  },
  // Application not running
  {
    pattern: /application isn't running|not running/i,
    message: "Mail.app is not responding. Try opening Mail.app manually."
  },
  // Connection errors
  {
    pattern: /connection is invalid|lost connection/i,
    message: "Lost connection to Mail.app. The app may have crashed or been restarted."
  },
  // Message not found
  {
    pattern: /can't get message/i,
    message: "Message not found. The message may have been deleted or moved."
  },
  // Mailbox not found
  {
    pattern: /can't get mailbox "([^"]+)"/i,
    message: 'Mailbox "$1" not found. Use list-mailboxes to see available mailboxes.'
  },
  // Account not found
  {
    pattern: /can't get account "([^"]+)"/i,
    message: 'Account "$1" not found. Use list-accounts to see available accounts.'
  },
  // Send failed
  {
    pattern: /couldn't send|send failed|cannot send/i,
    message: "Failed to send email. Check your network connection and Mail.app settings."
  },
  // Offline
  {
    pattern: /offline|no connection/i,
    message: "Mail.app is offline. Check your network connection."
  },
  // Cannot delete (various reasons)
  {
    pattern: /can't delete|cannot delete/i,
    message: "Cannot delete. The message may be locked or in use."
  },
  // Syntax/script errors (usually programming bugs)
  {
    pattern: /syntax error|expected/i,
    message: "Internal error. Please report this issue."
  }
];
function parseErrorMessage(errorOutput) {
  let coreError = errorOutput;
  const executionError = errorOutput.match(/execution error: (.+?)(?:\s*\(-?\d+\))?$/m);
  if (executionError) {
    coreError = executionError[1].trim();
  }
  for (const { pattern, message } of ERROR_MAPPINGS) {
    const match = coreError.match(pattern);
    if (match) {
      let result = message;
      for (let i = 1; i < match.length; i++) {
        result = result.replace(`$${i}`, match[i] || "");
      }
      return result;
    }
  }
  const notFoundError = coreError.match(/Can't get (.+?)\./);
  if (notFoundError) {
    return `Not found: ${notFoundError[1]}`;
  }
  if (/^Command failed:\s*osascript/.test(coreError.trim())) {
    return "Mail.app scripting failed (osascript exited abnormally). Mail may be unresponsive or relaunching, or Automation permission was denied \u2014 check System Settings > Privacy & Security > Automation, and try again.";
  }
  return coreError.trim() || "Unknown AppleScript error";
}
function executeAppleScript(script, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!script || !script.trim()) {
    return {
      success: false,
      output: "",
      error: "Cannot execute empty AppleScript"
    };
  }
  const preparedScript = escapeForShell(wrapWithTimeout(script.trim(), timeoutMs));
  const command = `osascript -e '${preparedScript}'`;
  debugLog("Executing AppleScript", {
    scriptPreview: script.trim().substring(0, 200) + (script.length > 200 ? "..." : ""),
    timeout: timeoutMs,
    maxRetries
  });
  let lastError = null;
  const startTime = Date.now();
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    try {
      const output = execSync(command, {
        encoding: "utf8",
        timeout: timeoutMs,
        // SIGKILL (not the default SIGTERM): a wedged osascript blocked on an
        // unresponsive Mail.app can ignore SIGTERM, leaking processes that pile
        // up and worsen the contention. SIGKILL guarantees the process is reaped
        // when the timeout fires. (#11)
        killSignal: "SIGKILL",
        // Raise the output cap well above Node's 1 MB default so large message
        // sources / attachment payloads aren't truncated into an ENOBUFS
        // failure. (#27)
        maxBuffer: getMaxBuffer(),
        // Capture stderr separately to get error details
        stdio: ["pipe", "pipe", "pipe"]
      });
      const duration = Date.now() - attemptStart;
      debugLog("AppleScript succeeded", {
        attempt,
        duration: `${duration}ms`,
        outputLength: output.length,
        outputPreview: output.substring(0, 100) + (output.length > 100 ? "..." : "")
      });
      return {
        success: true,
        output: output.trim()
      };
    } catch (error) {
      const attemptDuration = Date.now() - attemptStart;
      let errorMessage;
      let isTimeout = false;
      let rawError;
      if (isTimeoutError(error)) {
        isTimeout = true;
        const timeoutSecs = Math.round(timeoutMs / 1e3);
        errorMessage = `Operation timed out after ${timeoutSecs} seconds. Mail.app may be unresponsive or the operation involves too many messages.`;
      } else if (error instanceof Error) {
        rawError = error.message;
        errorMessage = parseErrorMessage(error.message);
      } else if (typeof error === "string") {
        rawError = error;
        errorMessage = parseErrorMessage(error);
      } else {
        errorMessage = "AppleScript execution failed with unknown error";
      }
      debugLog("AppleScript failed", {
        attempt,
        duration: `${attemptDuration}ms`,
        totalElapsed: `${Date.now() - startTime}ms`,
        isTimeout,
        errorMessage,
        rawError: rawError?.substring(0, 500)
      });
      lastError = {
        success: false,
        output: "",
        error: errorMessage
      };
      const canRetry = isTimeout || isRetryableError(errorMessage);
      const hasAttemptsLeft = attempt < maxRetries;
      if (canRetry && hasAttemptsLeft) {
        const delayMs = retryDelayMs * Math.pow(2, attempt - 1);
        console.error(
          `AppleScript retry: Attempt ${attempt}/${maxRetries} failed with "${errorMessage}". Retrying in ${delayMs}ms...`
        );
        sleep(delayMs);
      } else {
        if (isTimeout) {
          console.error(`AppleScript timeout: ${errorMessage}`);
        } else {
          console.error(`AppleScript error: ${errorMessage}`);
        }
        return lastError;
      }
    }
  }
  return lastError;
}

// src/utils/attachmentMaterialize.ts
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// src/utils/attachmentLimits.ts
var MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
var MAX_INLINE_ATTACHMENT_BASE64_CHARS = Math.ceil(MAX_INLINE_ATTACHMENT_BYTES / 3) * 4;
var MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS = MAX_INLINE_ATTACHMENT_BASE64_CHARS * 2;
function isInlineAttachmentBase64WithinLimit(contentBase64) {
  if (contentBase64.length > MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS) return false;
  let encodedChars = 0;
  for (const char of contentBase64) {
    if (!/\s/u.test(char) && ++encodedChars > MAX_INLINE_ATTACHMENT_BASE64_CHARS) return false;
  }
  return true;
}
function decodeInlineAttachment(contentBase64) {
  if (!isInlineAttachmentBase64WithinLimit(contentBase64)) {
    throw new Error("Inline attachment exceeds the 25 MiB decoded size limit.");
  }
  const content = Buffer.from(contentBase64, "base64");
  if (content.length > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error("Inline attachment exceeds the 25 MiB decoded size limit.");
  }
  return content;
}

// src/utils/attachmentMaterialize.ts
function materializeAttachments(attachments) {
  if (!attachments || attachments.length === 0) {
    return { paths: [], cleanup: () => void 0 };
  }
  let dir = null;
  let paths;
  try {
    paths = attachments.map((a) => {
      if (typeof a === "string") return a;
      if (!a.filename || !a.contentBase64) {
        throw new Error("Inline attachment requires both filename and contentBase64.");
      }
      if (!dir) dir = mkdtempSync(join(tmpdir(), "amcp-att-"));
      const safeName = a.filename.replace(/[/\\]/g, "_");
      const p = join(dir, safeName);
      writeFileSync(p, decodeInlineAttachment(a.contentBase64));
      return p;
    });
  } catch (error) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    paths,
    cleanup: () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };
}

// src/services/appleMailManager.ts
import {
  existsSync,
  writeFileSync as writeFileSync2,
  readFileSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
  renameSync,
  mkdtempSync as mkdtempSync2,
  rmSync as rmSync2,
  realpathSync,
  lstatSync
} from "fs";
import { isAbsolute, resolve, sep, join as join2 } from "path";
import { homedir } from "os";
var ALLOWED_SAVE_ROOTS = [homedir(), "/tmp", "/private/tmp", "/Volumes"];
function escapeForAppleScript(text) {
  if (!text) return "";
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f\x7f]/g, "");
}
function escapeForAppleScriptBody(text) {
  if (!text) return "";
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, "\\n").replace(/\t/g, "\\t").replace(/[\x00-\x1f\x7f]/g, "");
}
function buildAttachmentCommands(attachments) {
  if (!attachments || attachments.length === 0) return "";
  for (const filePath of attachments) {
    if (!isAbsolute(filePath)) {
      throw new Error(`Attachment path must be absolute: "${filePath}"`);
    }
    if (!existsSync(filePath)) {
      throw new Error(`Attachment file not found: "${filePath}"`);
    }
  }
  let commands = "";
  for (const filePath of attachments) {
    const safePath = escapeForAppleScript(filePath);
    commands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph
`;
  }
  return commands;
}

// src/services/draftManager.ts
var FIELD_SEP = "\u241FAPPLE_MAIL_DRAFT_FIELD\u241F";
var RECORD_SEP = "\u241EAPPLE_MAIL_DRAFT_RECORD\u241E";
var ADDRESS_SEP = "\u241DAPPLE_MAIL_DRAFT_ADDRESS\u241D";
var DRAFT_ID_PREFIX = "apple-draft:";
var DRAFT_ID_PATTERN = /^apple-draft:[0-9a-f-]{36}$/i;
function registryPathDefault() {
  return join3(homedir2(), "Library", "Application Support", "apple-mail-mcp", "draft-registry.json");
}
function formattedSender(fullName, email) {
  return fullName.trim() ? `${fullName.trim()} <${email.trim()}>` : email.trim();
}
function addressOnly(sender) {
  const match = sender.match(/<([^>]+)>/);
  return (match ? match[1] : sender).trim().toLowerCase();
}
function identityId(accountId, email) {
  return `mail-identity:${createHash("sha256").update(`${accountId}\0${email.trim().toLowerCase()}`).digest("hex").slice(0, 24)}`;
}
function splitAddresses(value) {
  if (!value) return [];
  return value.split(ADDRESS_SEP).map((item) => item.trim()).filter(Boolean);
}
function parseNativeDraftRow(row) {
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
    accountId: fields[9] || void 0,
    accountName: fields[10] || void 0,
    mailboxName: fields[11] || void 0,
    messageId: fields[12] || void 0,
    hasAttachments: fields[13] === "true"
  };
}
function fingerprintWithBody(draft, body) {
  return createHash("sha256").update(
    JSON.stringify({
      from: addressOnly(draft.from),
      to: draft.to.map((value) => value.trim().toLowerCase()),
      cc: draft.cc.map((value) => value.trim().toLowerCase()),
      bcc: draft.bcc.map((value) => value.trim().toLowerCase()),
      subject: draft.subject.trimEnd(),
      body
    })
  ).digest("hex");
}
function normalizedBody(value) {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}
function legacyNormalizedBody(value) {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trimEnd();
}
function fingerprint(draft) {
  return fingerprintWithBody(draft, normalizedBody(draft.body));
}
function draftContentFingerprint(draft) {
  return fingerprintWithBody(draft, normalizedBody(draft.body));
}
function fingerprintVariants(draft) {
  return [
    .../* @__PURE__ */ new Set([
      fingerprintWithBody(draft, normalizedBody(draft.body)),
      fingerprintWithBody(draft, legacyNormalizedBody(draft.body))
    ])
  ];
}
function sameBody(left, right) {
  return normalizedBody(left) === normalizedBody(right);
}
function draftIdFromUuid(uuid) {
  return `${DRAFT_ID_PREFIX}${uuid}`;
}
function nativeLocator(draft) {
  return draft.sourceKind === "mailbox" ? [
    "mailbox",
    draft.accountId ?? "",
    draft.mailboxName ?? "",
    draft.messageId ? "message-id" : "native-id",
    draft.messageId ?? draft.nativeId
  ].join("\0") : `compose\0${draft.nativeId}`;
}
function uuidFromDraftId(draftId) {
  return DRAFT_ID_PATTERN.test(draftId) ? draftId.slice(DRAFT_ID_PREFIX.length) : null;
}
function serializeRecipientList(variableName, kind, prefix) {
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
function serializeDraftExpression(variableName, source = { kind: "compose" }) {
  const sourceFields = source.kind === "mailbox" ? `"mailbox" & "${FIELD_SEP}" & \xAC
      ${source.accountIdVariable} & "${FIELD_SEP}" & \xAC
      ${source.accountNameVariable} & "${FIELD_SEP}" & \xAC
      ${source.mailboxNameVariable} & "${FIELD_SEP}" & \xAC
      draftMessageId & "${FIELD_SEP}" & \xAC
      hasAttachments & "${FIELD_SEP}"` : `"compose" & "${FIELD_SEP}" & \xAC
      "" & "${FIELD_SEP}" & \xAC
      "" & "${FIELD_SEP}" & \xAC
      "" & "${FIELD_SEP}" & \xAC
      "" & "${FIELD_SEP}" & \xAC
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
    set rowText to ((id of ${variableName}) as text) & "${FIELD_SEP}" & \xAC
      (sender of ${variableName} as text) & "${FIELD_SEP}" & \xAC
      (subject of ${variableName} as text) & "${FIELD_SEP}" & \xAC
      (content of ${variableName} as text) & "${FIELD_SEP}" & \xAC
      ${source.kind === "compose" ? `((visible of ${variableName}) as text)` : `"false"`} & "${FIELD_SEP}" & \xAC
      toJoined & "${FIELD_SEP}" & \xAC
      ccJoined & "${FIELD_SEP}" & \xAC
      bccJoined & "${FIELD_SEP}" & \xAC
      ${sourceFields}
  `;
}
function recipientCommands(kind, addresses) {
  return addresses.map(
    (address) => `make new ${kind} recipient at end of ${kind} recipients with properties {address:"${escapeForAppleScript(address)}"}`
  ).join("\n");
}
function replaceRecipients(kind, addresses) {
  return `
    repeat while (count of ${kind} recipients of draftMessage) > 0
      delete item 1 of ${kind} recipients of draftMessage
    end repeat
    ${recipientCommands(kind, addresses)}
  `;
}
function buildListDraftsAppleScript() {
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
    mailboxNameVariable: "mailboxNameText"
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
var DraftManager = class {
  registryPath;
  execute;
  constructor(options = {}) {
    this.registryPath = options.registryPath ?? registryPathDefault();
    this.execute = options.execute ?? executeAppleScript;
  }
  loadRegistry() {
    try {
      if (!existsSync2(this.registryPath)) return { version: 1, drafts: {} };
      const parsed = JSON.parse(readFileSync2(this.registryPath, "utf8"));
      if (parsed.version !== 1 || !parsed.drafts || typeof parsed.drafts !== "object") {
        return { version: 1, drafts: {} };
      }
      return parsed;
    } catch {
      return { version: 1, drafts: {} };
    }
  }
  saveRegistry(registry) {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync3(tmp, `${JSON.stringify(registry, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    renameSync2(tmp, this.registryPath);
  }
  listSendingIdentities() {
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
    return result.output.split(RECORD_SEP).map((row) => {
      const [accountId, accountName, fullName, email, enabled, defaultSender] = row.split(FIELD_SEP);
      if (!accountId || !email) return null;
      return {
        identityId: identityId(accountId, email),
        accountId,
        accountName,
        email,
        fullName: fullName ?? "",
        sender: formattedSender(fullName ?? "", email),
        enabled: enabled === "true",
        isDefault: addressOnly(defaultSender ?? "") === email.trim().toLowerCase()
      };
    }).filter((item) => item !== null);
  }
  getDefaultIdentity() {
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
  setDefaultIdentity(identitySelector) {
    const selector = identitySelector.trim().toLowerCase();
    const identities = this.listSendingIdentities();
    const matches = identities.filter(
      (identity) => identity.identityId.toLowerCase() === selector || identity.email.toLowerCase() === selector || identity.sender.toLowerCase() === selector
    );
    if (matches.length !== 1 || !matches[0].enabled) return null;
    const registry = this.loadRegistry();
    registry.defaultIdentityId = matches[0].identityId;
    this.saveRegistry(registry);
    return matches[0];
  }
  resolveIdentity(selector) {
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
      (identity) => identity.identityId.toLowerCase() === normalized || identity.email.toLowerCase() === normalized || identity.sender.toLowerCase() === normalized
    );
    return matches.length === 1 && matches[0].enabled ? matches[0] : null;
  }
  listNativeDrafts() {
    const script = buildListDraftsAppleScript();
    const result = this.execute(script, { timeoutMs: 6e4 });
    if (!result.success) return { drafts: [], error: result.error ?? "Failed to list drafts" };
    if (!result.output.trim()) return { drafts: [] };
    return {
      drafts: result.output.split(RECORD_SEP).map(parseNativeDraftRow).filter((draft) => draft !== null)
    };
  }
  syncRegistry(nativeDrafts) {
    const registry = this.loadRegistry();
    const discarded = registry.discardedFingerprints ?? {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1e3;
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
    const output = [];
    for (const native of nativeDrafts) {
      const fp = fingerprint(native);
      const variants = fingerprintVariants(native);
      const locator = nativeLocator(native);
      if (discardedLocators[locator]) continue;
      if (variants.some((candidate) => discarded[candidate])) {
        if (native.sourceKind === "mailbox") {
          discardedLocators[locator] = (/* @__PURE__ */ new Date()).toISOString();
        }
        continue;
      }
      let uuid = [...unmatched].find((candidate) => {
        const entry = registry.drafts[candidate];
        return (entry.locator === nativeLocator(native) || entry.nativeId === native.nativeId) && variants.includes(entry.fingerprint);
      });
      if (!uuid) {
        uuid = [...unmatched].find(
          (candidate) => variants.includes(registry.drafts[candidate].fingerprint)
        );
      }
      if (!uuid) uuid = randomUUID();
      unmatched.delete(uuid);
      registry.drafts[uuid] = {
        nativeId: native.nativeId,
        locator: nativeLocator(native),
        fingerprint: fp,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      output.push({ draftId: draftIdFromUuid(uuid), ...native });
    }
    for (const stale of unmatched) delete registry.drafts[stale];
    this.saveRegistry(registry);
    return output;
  }
  listDrafts() {
    const native = this.listNativeDrafts();
    if (native.error) return { success: false, error: native.error };
    return { success: true, drafts: this.syncRegistry(native.drafts) };
  }
  getDraft(draftId) {
    const listed = this.listDrafts();
    if (!listed.success) return listed;
    const draft = listed.drafts?.find((item) => item.draftId === draftId);
    return draft ? { success: true, draft } : { success: false, error: `Draft "${draftId}" was not found. List drafts again.` };
  }
  createNativeDraft(input) {
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
      const result = this.execute(script, { timeoutMs: 6e4, maxRetries: 2 });
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
  createDraft(input) {
    const identity = this.resolveIdentity(input.from);
    if (input.from && !identity) {
      return {
        success: false,
        error: `Sending identity "${input.from}" is unavailable or ambiguous. List sending identities first.`
      };
    }
    const created = this.createNativeDraft({
      ...input,
      sender: identity?.sender
    });
    if (!created.success || !created.draft) {
      return { success: false, error: created.error ?? "Failed to create draft." };
    }
    const native = created.draft;
    try {
      const listed = this.listNativeDrafts();
      const draftsToSync = listed.drafts.some(
        (item) => item.nativeId === native.nativeId && fingerprint(item) === fingerprint(native)
      ) ? listed.drafts : [...listed.drafts, native];
      const draft = this.syncRegistry(draftsToSync).find(
        (item) => item.nativeId === native.nativeId && fingerprint(item) === fingerprint(native)
      );
      return draft ? { success: true, draft } : { success: false, error: "Draft created but could not be registered." };
    } catch (error) {
      return {
        success: false,
        error: `Draft created but registration failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  updateDraft(draftId, update) {
    const uuid = uuidFromDraftId(draftId);
    if (!uuid) return { success: false, error: `Invalid draft id "${draftId}".` };
    const current = this.getDraft(draftId);
    if (!current.success || !current.draft) return current;
    let sender;
    if (update.from !== void 0) {
      const identity = this.resolveIdentity(update.from);
      if (!identity) {
        return {
          success: false,
          error: `Sending identity "${update.from}" is unavailable or ambiguous.`
        };
      }
      sender = identity.sender;
    }
    if (update.body !== void 0 || current.draft.sourceKind === "mailbox") {
      if (current.draft.hasAttachments) {
        return {
          success: false,
          error: "This draft has attachments. Mail.app cannot safely recreate it through AppleScript without changing its MIME structure; edit it in Mail.app."
        };
      }
      const desired = {
        nativeId: current.draft.nativeId,
        from: sender ?? current.draft.from,
        to: update.to ?? current.draft.to,
        cc: update.cc ?? current.draft.cc,
        bcc: update.bcc ?? current.draft.bcc,
        subject: update.subject ?? current.draft.subject,
        body: update.body ?? current.draft.body,
        visible: false,
        sourceKind: "compose",
        hasAttachments: false
      };
      const replacement = this.createNativeDraft({
        sender: desired.from,
        to: desired.to,
        cc: desired.cc,
        bcc: desired.bcc,
        subject: desired.subject,
        body: desired.body
      });
      if (!replacement.success || !replacement.draft) {
        return {
          success: false,
          error: `Original draft was preserved because replacement creation failed: ${replacement.error ?? "unknown error"}`
        };
      }
      const actual = replacement.draft;
      const verified = addressOnly(actual.from) === addressOnly(desired.from) && actual.subject.trimEnd() === desired.subject.trimEnd() && sameBody(actual.body, desired.body) && JSON.stringify(actual.to) === JSON.stringify(desired.to) && JSON.stringify(actual.cc) === JSON.stringify(desired.cc) && JSON.stringify(actual.bcc) === JSON.stringify(desired.bcc);
      if (!verified) {
        return {
          success: false,
          error: "Original draft was preserved because Mail did not reproduce the requested replacement exactly. The replacement draft was left for manual inspection."
        };
      }
      const discarded = this.discardNativeDraft(current.draft);
      if (!discarded.success) {
        return {
          success: false,
          error: `Replacement was verified, but the original draft could not be removed: ${discarded.error}`
        };
      }
      const registry2 = this.loadRegistry();
      if (current.draft.sourceKind === "compose" && fingerprint(current.draft) !== fingerprint(actual)) {
        registry2.discardedFingerprints ??= {};
        registry2.discardedFingerprints[fingerprint(current.draft)] = (/* @__PURE__ */ new Date()).toISOString();
      }
      for (const [candidate, entry] of Object.entries(registry2.drafts)) {
        if (candidate !== uuid && entry.fingerprint === fingerprint(actual)) {
          delete registry2.drafts[candidate];
        }
      }
      registry2.drafts[uuid] = {
        nativeId: actual.nativeId,
        locator: nativeLocator(actual),
        fingerprint: fingerprint(actual),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.saveRegistry(registry2);
      return { success: true, draft: { draftId, ...actual } };
    }
    const commands = [
      update.subject !== void 0 ? `set subject of draftMessage to "${escapeForAppleScript(update.subject)}"` : "",
      update.body !== void 0 ? `set content of draftMessage to "${escapeForAppleScriptBody(update.body)}"` : "",
      sender !== void 0 ? `set sender of draftMessage to "${escapeForAppleScript(sender)}"` : "",
      update.to !== void 0 ? replaceRecipients("to", update.to) : "",
      update.cc !== void 0 ? replaceRecipients("cc", update.cc) : "",
      update.bcc !== void 0 ? replaceRecipients("bcc", update.bcc) : ""
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
    const result = this.execute(script, { timeoutMs: 6e4 });
    if (!result.success || result.output.startsWith("error:")) {
      return {
        success: false,
        error: result.output.replace(/^error:/, "") || result.error || "Failed to update draft"
      };
    }
    const native = parseNativeDraftRow(result.output);
    if (!native) return { success: false, error: "Mail updated the draft but returned no handle." };
    const registry = this.loadRegistry();
    registry.drafts[uuid] = {
      nativeId: native.nativeId,
      locator: nativeLocator(native),
      fingerprint: fingerprint(native),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.saveRegistry(registry);
    return { success: true, draft: { draftId, ...native } };
  }
  sendDraft(draftId) {
    const uuid = uuidFromDraftId(draftId);
    if (!uuid) return { success: false, error: `Invalid draft id "${draftId}".` };
    const current = this.getDraft(draftId);
    if (!current.success || !current.draft) return current;
    if (current.draft.sourceKind === "mailbox" && current.draft.hasAttachments) {
      return {
        success: false,
        error: "This saved draft has attachments. Send it from Mail.app so its original MIME structure is preserved."
      };
    }
    const script = current.draft.sourceKind === "mailbox" ? `
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
    ` : `
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
    const result = this.execute(script, { timeoutMs: 6e4 });
    if (!result.success || result.output !== "sent") {
      return {
        success: false,
        error: result.output.replace(/^error:/, "") || result.error || "Failed to send draft"
      };
    }
    if (current.draft.sourceKind === "mailbox") {
      this.discardNativeDraft(current.draft);
    }
    const registry = this.loadRegistry();
    if (current.draft.sourceKind === "compose") {
      registry.discardedFingerprints ??= {};
      registry.discardedFingerprints[fingerprint(current.draft)] = (/* @__PURE__ */ new Date()).toISOString();
    }
    delete registry.drafts[uuid];
    this.saveRegistry(registry);
    return { success: true, draft: current.draft };
  }
  discardNativeDraft(draft) {
    if (draft.sourceKind === "mailbox" && draft.accountId && draft.mailboxName) {
      const script2 = `
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
      const result2 = this.execute(script2, { timeoutMs: 6e4 });
      if (!result2.success || result2.output.startsWith("error:")) {
        return {
          success: false,
          error: result2.output.replace(/^error:/, "") || result2.error || "Failed to delete saved draft"
        };
      }
      return { success: true };
    }
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
    const result = this.execute(script, { timeoutMs: 6e4 });
    if (!result.success || result.output.startsWith("error:")) {
      return {
        success: false,
        error: result.output.replace(/^error:/, "") || result.error || "Failed to delete draft"
      };
    }
    return { success: true };
  }
  deleteDraft(draftId) {
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
      registry.discardedFingerprints[fingerprint(draft)] = (/* @__PURE__ */ new Date()).toISOString();
    }
    delete registry.drafts[uuid];
    this.saveRegistry(registry);
    return { success: true, draft };
  }
};

// src/services/scheduledSendManager.ts
var MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1e3;
var MIN_SCHEDULE_LEAD_MS = 30 * 1e3;
var STUCK_SENDING_MS = 5 * 60 * 1e3;
function scheduleRegistryPathDefault() {
  return join4(
    homedir3(),
    "Library",
    "Application Support",
    "apple-mail-mcp",
    "scheduled-sends.json"
  );
}
function emptyStore() {
  return { version: 1, jobs: {} };
}
function parseScheduledInstant(value, now = /* @__PURE__ */ new Date()) {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/i
  );
  if (!match) {
    return {
      success: false,
      error: 'send_at must be RFC 3339 with an explicit timezone, for example "2026-07-29T07:00:00+08:00".'
    };
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zone,
    zoneHour,
    zoneMinute
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? "0");
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  const offsetHour = zone.toUpperCase() === "Z" ? 0 : Number(zoneHour);
  const offsetMinute = zone.toUpperCase() === "Z" ? 0 : Number(zoneMinute);
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute !== 0) {
    return { success: false, error: `Invalid send_at value "${value}".` };
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return { success: false, error: `Invalid send_at value "${value}".` };
  }
  const lead = date.getTime() - now.getTime();
  if (lead < MIN_SCHEDULE_LEAD_MS) {
    return { success: false, error: "send_at must be at least 30 seconds in the future." };
  }
  if (lead > MAX_SCHEDULE_AHEAD_MS) {
    return { success: false, error: "send_at cannot be more than 366 days in the future." };
  }
  return { success: true, date };
}
function snapshotDraft(draft) {
  return {
    draftId: draft.draftId,
    fingerprint: draftContentFingerprint(draft),
    from: draft.from,
    to: [...draft.to],
    cc: [...draft.cc],
    bcc: [...draft.bcc],
    subject: draft.subject,
    messageId: draft.messageId
  };
}
var ScheduledSendManager = class {
  registryPath;
  lockPath;
  draftManager;
  now;
  ensureWorker;
  lockStaleMs;
  constructor(options = {}) {
    this.registryPath = options.registryPath ?? scheduleRegistryPathDefault();
    this.lockPath = `${this.registryPath}.lock`;
    this.draftManager = options.draftManager ?? new DraftManager();
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.ensureWorker = options.ensureWorker ?? (() => ({ success: true }));
    this.lockStaleMs = options.lockStaleMs ?? 2 * 60 * 1e3;
  }
  loadStore() {
    if (!existsSync3(this.registryPath)) return emptyStore();
    try {
      const parsed = JSON.parse(
        readFileSync3(this.registryPath, "utf8")
      );
      if (parsed.version !== 1 || !parsed.jobs || typeof parsed.jobs !== "object") {
        throw new Error("unsupported or incomplete registry format");
      }
      return parsed;
    } catch (error) {
      throw new Error(
        `Scheduled-send registry is unreadable; no jobs were changed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  saveStore(store) {
    mkdirSync2(dirname2(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync4(tmp, `${JSON.stringify(store, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    renameSync3(tmp, this.registryPath);
  }
  withLock(operation) {
    mkdirSync2(dirname2(this.lockPath), { recursive: true });
    let fd;
    try {
      fd = openSync(this.lockPath, "wx", 384);
    } catch (error) {
      try {
        const age = Date.now() - statSync(this.lockPath).mtimeMs;
        if (age > this.lockStaleMs) {
          unlinkSync2(this.lockPath);
          fd = openSync(this.lockPath, "wx", 384);
        } else {
          throw new Error("Scheduled-send registry is busy; retry shortly.");
        }
      } catch (inner) {
        if (inner instanceof Error && inner.message.includes("registry is busy")) throw inner;
        throw error;
      }
    }
    try {
      return operation();
    } finally {
      closeSync(fd);
      try {
        unlinkSync2(this.lockPath);
      } catch {
      }
    }
  }
  list(status) {
    const jobs = Object.values(this.loadStore().jobs);
    return jobs.filter((job) => !status || job.status === status).sort((left, right) => left.sendAt.localeCompare(right.sendAt));
  }
  activeForDraft(draftId) {
    return this.list().find(
      (job) => job.draftId === draftId && (job.status === "pending" || job.status === "sending")
    ) ?? null;
  }
  scheduleDrafts(draftIds, sendAt) {
    const uniqueIds = [...new Set(draftIds)];
    if (uniqueIds.length === 0) {
      return { success: false, error: "At least one draft_id is required." };
    }
    if (uniqueIds.length > 100) {
      return { success: false, error: "Cannot schedule more than 100 drafts at once." };
    }
    const parsed = parseScheduledInstant(sendAt, this.now());
    if (!parsed.success) return parsed;
    const drafts = [];
    for (const draftId of uniqueIds) {
      const found = this.draftManager.getDraft(draftId);
      if (!found.success || !found.draft) {
        return {
          success: false,
          error: found.error ?? `Draft "${draftId}" was not found.`
        };
      }
      if (found.draft.hasAttachments) {
        return {
          success: false,
          error: `Draft "${draftId}" has attachments and cannot be safely scheduled through Mail's scripting bridge.`
        };
      }
      if (found.draft.to.length + found.draft.cc.length + found.draft.bcc.length === 0) {
        return { success: false, error: `Draft "${draftId}" has no recipients.` };
      }
      drafts.push(found.draft);
    }
    const created = this.withLock(() => {
      const store = this.loadStore();
      for (const draft of drafts) {
        const existing = Object.values(store.jobs).find(
          (job) => job.draftId === draft.draftId && (job.status === "pending" || job.status === "sending")
        );
        if (existing) {
          return {
            success: false,
            error: `Draft "${draft.draftId}" is already scheduled as ${existing.scheduleId}.`
          };
        }
      }
      const now = this.now().toISOString();
      const schedules = drafts.map((draft) => {
        const scheduleId = `apple-schedule:${randomUUID2()}`;
        const job = {
          scheduleId,
          draftId: draft.draftId,
          status: "pending",
          sendAt: parsed.date.toISOString(),
          requestedSendAt: sendAt.trim(),
          createdAt: now,
          updatedAt: now,
          snapshot: snapshotDraft(draft)
        };
        store.jobs[scheduleId] = job;
        return job;
      });
      this.saveStore(store);
      return { success: true, schedules };
    });
    if (!created.success || !created.schedules) return created;
    const worker = this.ensureWorker();
    if (!worker.success) {
      const createdIds = new Set(created.schedules.map((job) => job.scheduleId));
      this.withLock(() => {
        const store = this.loadStore();
        for (const scheduleId of createdIds) delete store.jobs[scheduleId];
        this.saveStore(store);
      });
      return {
        success: false,
        error: worker.error ?? "Could not install the scheduled-send worker."
      };
    }
    return created;
  }
  cancel(scheduleId) {
    return this.withLock(() => {
      const store = this.loadStore();
      const job = store.jobs[scheduleId];
      if (!job) return { success: false, error: `Schedule "${scheduleId}" was not found.` };
      if (job.status !== "pending") {
        return {
          success: false,
          error: `Schedule "${scheduleId}" is ${job.status} and can no longer be cancelled.`
        };
      }
      const now = this.now().toISOString();
      job.status = "cancelled";
      job.cancelledAt = now;
      job.updatedAt = now;
      this.saveStore(store);
      return { success: true, schedule: job };
    });
  }
  reschedule(scheduleId, sendAt) {
    const parsed = parseScheduledInstant(sendAt, this.now());
    if (!parsed.success) return parsed;
    let previous = null;
    const changed = this.withLock(() => {
      const store = this.loadStore();
      const job = store.jobs[scheduleId];
      if (!job) return { success: false, error: `Schedule "${scheduleId}" was not found.` };
      if (job.status !== "pending") {
        return {
          success: false,
          error: `Schedule "${scheduleId}" is ${job.status} and can no longer be rescheduled.`
        };
      }
      previous = { sendAt: job.sendAt, requestedSendAt: job.requestedSendAt };
      job.sendAt = parsed.date.toISOString();
      job.requestedSendAt = sendAt.trim();
      job.updatedAt = this.now().toISOString();
      this.saveStore(store);
      return { success: true, schedule: job };
    });
    if (!changed.success || !changed.schedule) return changed;
    const worker = this.ensureWorker();
    if (!worker.success && previous) {
      this.withLock(() => {
        const store = this.loadStore();
        const job = store.jobs[scheduleId];
        if (job?.status === "pending") {
          job.sendAt = previous?.sendAt ?? job.sendAt;
          job.requestedSendAt = previous?.requestedSendAt ?? job.requestedSendAt;
          job.updatedAt = this.now().toISOString();
          this.saveStore(store);
        }
      });
      return {
        success: false,
        error: worker.error ?? "Could not refresh the scheduled-send worker."
      };
    }
    return changed;
  }
  /**
   * Milliseconds until the worker should check again, or null when no active
   * schedule requires it to stay alive. Capped so cancellation/rescheduling
   * and clock changes are observed promptly.
   */
  nextWorkerDelayMs(maxPollMs = 3e4) {
    const now = this.now().getTime();
    const waits = this.list().filter((job) => job.status === "pending" || job.status === "sending").map((job) => {
      if (job.status === "pending") return new Date(job.sendAt).getTime() - now;
      const started = job.startedAt ? new Date(job.startedAt).getTime() : now;
      return started + STUCK_SENDING_MS - now;
    });
    if (waits.length === 0) return null;
    return Math.min(Math.max(Math.min(...waits), 250), maxPollMs);
  }
  markResult(scheduleId, status, error) {
    return this.withLock(() => {
      const store = this.loadStore();
      const job = store.jobs[scheduleId];
      if (!job || job.status !== "sending") return null;
      const now = this.now().toISOString();
      job.status = status;
      job.updatedAt = now;
      if (status === "sent") job.sentAt = now;
      if (error) job.error = error;
      this.saveStore(store);
      return job;
    });
  }
  claimDue() {
    return this.withLock(() => {
      const store = this.loadStore();
      const now = this.now();
      let changed = false;
      for (const job of Object.values(store.jobs)) {
        if (job.status === "sending" && job.startedAt && now.getTime() - new Date(job.startedAt).getTime() >= STUCK_SENDING_MS) {
          job.status = "needs_review";
          job.error = "Worker stopped after marking this job as sending. It was not retried to avoid a duplicate.";
          job.updatedAt = now.toISOString();
          changed = true;
        }
      }
      const due = Object.values(store.jobs).filter(
        (job) => job.status === "pending" && new Date(job.sendAt).getTime() <= now.getTime()
      ).sort((left, right) => left.sendAt.localeCompare(right.sendAt))[0];
      if (!due) {
        if (changed) this.saveStore(store);
        return null;
      }
      due.status = "sending";
      due.startedAt = now.toISOString();
      due.updatedAt = now.toISOString();
      this.saveStore(store);
      return JSON.parse(JSON.stringify(due));
    });
  }
  runDueSends() {
    const results = [];
    while (true) {
      const job = this.claimDue();
      if (!job) break;
      const current = this.draftManager.getDraft(job.draftId);
      if (!current.success || !current.draft) {
        const error = current.error ?? "Scheduled draft was not found.";
        this.markResult(job.scheduleId, "failed", error);
        results.push({ scheduleId: job.scheduleId, status: "failed", error });
        continue;
      }
      if (draftContentFingerprint(current.draft) !== job.snapshot.fingerprint) {
        const error = "Draft content changed after scheduling; it was not sent.";
        this.markResult(job.scheduleId, "failed", error);
        results.push({ scheduleId: job.scheduleId, status: "failed", error });
        continue;
      }
      const sent = this.draftManager.sendDraft(job.draftId);
      if (!sent.success) {
        const error = sent.error ?? "Mail.app failed to send the scheduled draft.";
        this.markResult(job.scheduleId, "failed", error);
        results.push({ scheduleId: job.scheduleId, status: "failed", error });
        continue;
      }
      this.markResult(job.scheduleId, "sent");
      results.push({ scheduleId: job.scheduleId, status: "sent" });
    }
    return results;
  }
};

// src/services/fileConfig.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";
import { join as join5 } from "path";
import { homedir as homedir4 } from "os";
function fileConfigPath(env = process.env) {
  const override = env.APPLE_MAIL_MCP_CONFIG_FILE;
  if (override && override.trim()) return override.trim();
  return join5(homedir4(), "Library", "Application Support", "apple-mail-mcp", "config.json");
}
function loadFileConfig(env = process.env, path = fileConfigPath(env)) {
  const applied = [];
  try {
    if (!existsSync4(path)) return applied;
    const parsed = JSON.parse(readFileSync4(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return applied;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") continue;
      if (env[k] === void 0 || env[k] === "") {
        env[k] = v;
        applied.push(k);
      }
    }
  } catch (e) {
    console.error(`Failed to load apple-mail-mcp config file ${path}: ${String(e)}`);
  }
  return applied;
}

// src/schedulerCli.ts
function runSchedulerCli(argv, deps = {}) {
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));
  if (argv.includes("--help")) {
    out("apple-mail scheduled-send worker (normally started by launchd)");
    return 0;
  }
  try {
    loadFileConfig();
    const manager = deps.manager ?? new ScheduledSendManager();
    const results = manager.runDueSends();
    if (results.length > 0) out(JSON.stringify(results));
    return results.some((result) => result.status === "failed") ? 1 : 0;
  } catch (error) {
    err(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}
async function runSchedulerLoop(deps = {}) {
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));
  const sleep2 = deps.sleep ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  try {
    loadFileConfig();
    const manager = deps.manager ?? new ScheduledSendManager();
    while (true) {
      const results = manager.runDueSends();
      if (results.length > 0) out(JSON.stringify(results));
      const delay = manager.nextWorkerDelayMs?.() ?? null;
      if (delay === null) return 0;
      await sleep2(delay);
    }
  } catch (error) {
    err(error instanceof Error ? error.stack ?? error.message : String(error));
    return 0;
  }
}
function isInvokedDirectly() {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  try {
    return realpathSync2(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isInvokedDirectly()) {
  if (process.argv.slice(2).includes("--help")) {
    process.exit(runSchedulerCli(["--help"]));
  }
  runSchedulerLoop().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(0);
    }
  );
}
export {
  runSchedulerCli,
  runSchedulerLoop
};
