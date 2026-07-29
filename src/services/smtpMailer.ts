/**
 * SMTP transport for sending mail (issue #12).
 *
 * Mail.app's AppleScript send path wraps any injected body in
 * `<blockquote type="cite">` under the Apple-Mail-URLShareWrapperClass template
 * on macOS 15+, so messages render to recipients as quoted/forwarded content
 * (Apple radar FB11734014, open since Ventura). This module bypasses Mail.app
 * entirely and submits clean MIME directly over SMTP via nodemailer.
 *
 * Connection settings come from environment variables; the password is read
 * from the macOS Keychain via the `security` CLI by default so no secret is
 * ever placed in config. When SMTP is configured, `send-email` auto-prefers it
 * over AppleScript (opt out per call with `transport: "applescript"`); see
 * {@link shouldUseSmtp}.
 *
 * @module services/smtpMailer
 */

import nodemailer from "nodemailer";
import { execFileSync } from "child_process";
import { isAbsolute } from "path";
import { existsSync } from "fs";
import type { AttachmentInput } from "@/types.js";
import { decodeInlineAttachment } from "@/utils/attachmentLimits.js";
import { SETUP_HINT } from "@/utils/docsUrls.js";

/** Options for an SMTP send, mirroring the AppleScript send-email surface. */
export interface SmtpSendOptions {
  to: string[];
  subject: string;
  /** Plain-text body. Always sent as the text/plain part. */
  body: string;
  cc?: string[];
  bcc?: string[];
  /** Overrides the configured From address (must be allowed by the SMTP server). */
  from?: string;
  /** Files to attach: absolute paths and/or inline base64 content (B4). */
  attachments?: AttachmentInput[];
  /**
   * Optional HTML body. When provided, the message is sent as
   * multipart/alternative ({@link SmtpSendOptions.body} as the text/plain part,
   * this as the text/html part) so clients pick the richer rendering while
   * plain-text clients still get a clean fallback.
   */
  htmlBody?: string;
  /**
   * RFC 5322 threading (2.5.0): the message this is replying to — emitted as the
   * `In-Reply-To` header so SMTP replies/forwards thread correctly in Gmail and
   * other clients. Pass the original message's `Message-ID`.
   */
  inReplyTo?: string;
  /**
   * RFC 5322 threading (2.5.0): the `References` chain — the original message's
   * existing `References` plus its `Message-ID`. nodemailer accepts an array.
   */
  references?: string[];
}

/** Resolved SMTP connection configuration. */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  allowedFrom?: string[];
}

/** Result of an SMTP send. */
export interface SmtpSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /**
   * True when the connection failed after submission may have started and the
   * caller must not automatically retry.
   */
  uncertain?: boolean;
}

export interface RawSmtpEnvelope {
  from: string;
  to: string[];
}

/**
 * Environment variables consumed by {@link resolveSmtpConfig}. Documented here
 * (and in the README) so the error path can point users at exactly what to set.
 */
export const SMTP_ENV = {
  host: "APPLE_MAIL_MCP_SMTP_HOST",
  port: "APPLE_MAIL_MCP_SMTP_PORT",
  secure: "APPLE_MAIL_MCP_SMTP_SECURE",
  user: "APPLE_MAIL_MCP_SMTP_USER",
  from: "APPLE_MAIL_MCP_SMTP_FROM",
  allowedFrom: "APPLE_MAIL_MCP_SMTP_ALLOWED_FROM",
  password: "APPLE_MAIL_MCP_SMTP_PASSWORD",
  keychainService: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE",
  keychainAccount: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_ACCOUNT",
  // JSON array of additional transport profiles. Each entry supports:
  // account, host, port, secure, user, from, allowedFrom, password,
  // keychainService, and keychainAccount.
  accounts: "APPLE_MAIL_MCP_SMTP_ACCOUNTS",
} as const;

/**
 * Cheap check for whether the SMTP transport is configured at all, i.e. the two
 * required settings ({@link SMTP_ENV.host} and {@link SMTP_ENV.user}) are
 * present. Used to auto-prefer SMTP over AppleScript when no transport is
 * explicitly requested, and by `doctor`. Does NOT touch the Keychain or verify
 * the password — a misconfigured password still surfaces a clear error at send
 * time via {@link resolveSmtpConfig}.
 */
export function isSmtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[SMTP_ENV.host]?.trim() && env[SMTP_ENV.user]?.trim()) return true;
  const json = env[SMTP_ENV.accounts]?.trim();
  if (!json) return false;
  try {
    const profiles: unknown = JSON.parse(json);
    return (
      Array.isArray(profiles) &&
      profiles.some(
        (profile) =>
          typeof profile === "object" &&
          profile !== null &&
          typeof (profile as Record<string, unknown>).host === "string" &&
          typeof (profile as Record<string, unknown>).user === "string"
      )
    );
  } catch {
    return false;
  }
}

/**
 * Decides whether `send-email` should use the SMTP transport for this call.
 *
 * - explicit `"smtp"` → always SMTP (config errors surface, no fallback);
 * - explicit `"applescript"` → always the Mail.app path;
 * - omitted → SMTP when configured, **except** when a non-email `account` label
 *   (a Mail.app account name such as `"Work"`) is supplied. That requests
 *   account-based sending, which only the AppleScript path can do, so we honor
 *   the caller's intent instead of silently switching their account. An
 *   `account` that is an email address is treated as a From override and does
 *   not block SMTP.
 */
export function shouldUseSmtp(
  transport: "applescript" | "smtp" | undefined,
  account: string | undefined,
  configured: boolean = isSmtpConfigured()
): boolean {
  if (transport === "smtp") return true;
  if (transport === "applescript") return false;
  if (!configured) return false;
  const isAccountLabel = Boolean(account && !account.includes("@"));
  return !isAccountLabel;
}

/**
 * Reads a password from the macOS login Keychain via the `security` CLI.
 *
 * Tries `find-internet-password` first (where Mail.app stores account
 * passwords) and falls back to `find-generic-password`. Returns null if no
 * matching item exists or the lookup fails for any reason — callers fall back
 * to the password env var and ultimately surface a clear configuration error.
 *
 * @param service - Keychain service / server name (typically the SMTP host)
 * @param account - Keychain account (typically the SMTP username)
 */
export function readKeychainPassword(service: string, account: string): string | null {
  for (const kind of ["find-internet-password", "find-generic-password"] as const) {
    try {
      const out = execFileSync("security", [kind, "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pass = out.replace(/\n$/, "");
      if (pass) return pass;
    } catch {
      // Not found via this kind; try the next.
    }
  }
  return null;
}

/**
 * Resolves SMTP connection configuration from environment + Keychain.
 *
 * @throws Error with an actionable message listing the missing settings.
 */
export function resolveSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const host = env[SMTP_ENV.host]?.trim();
  const user = env[SMTP_ENV.user]?.trim();

  const missing: string[] = [];
  if (!host) missing.push(SMTP_ENV.host);
  if (!user) missing.push(SMTP_ENV.user);
  if (missing.length > 0) {
    throw new Error(
      `SMTP transport is not configured. Set ${missing.join(" and ")} ` +
        `(plus a password via ${SMTP_ENV.password} or the Keychain). ` +
        SETUP_HINT
    );
  }

  // secure=true => implicit TLS (port 465); otherwise STARTTLS (port 587).
  const secure = /^(1|true|yes)$/i.test(env[SMTP_ENV.secure]?.trim() ?? "");
  const port = env[SMTP_ENV.port]
    ? Number.parseInt(env[SMTP_ENV.port] as string, 10)
    : secure
      ? 465
      : 587;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid ${SMTP_ENV.port}: "${env[SMTP_ENV.port]}" is not a valid port.`);
  }

  const from = env[SMTP_ENV.from]?.trim() || (user as string);
  const allowedFrom = (env[SMTP_ENV.allowedFrom] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  // Password: explicit env var wins, otherwise Keychain (service/account
  // default to the host/user but can be overridden).
  let pass = env[SMTP_ENV.password];
  if (!pass) {
    const service = env[SMTP_ENV.keychainService]?.trim() || (host as string);
    const account = env[SMTP_ENV.keychainAccount]?.trim() || (user as string);
    pass = readKeychainPassword(service, account) ?? undefined;
  }
  if (!pass) {
    throw new Error(
      `No SMTP password found. Set ${SMTP_ENV.password}, or store an internet ` +
        `password in the Keychain for service "${
          env[SMTP_ENV.keychainService]?.trim() || host
        }" / account "${env[SMTP_ENV.keychainAccount]?.trim() || user}". ` +
        SETUP_HINT
    );
  }

  return { host: host as string, port, secure, user: user as string, pass, from, allowedFrom };
}

interface SmtpProfileSpec {
  account?: string;
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  from?: string;
  allowedFrom?: string[];
  password?: string;
  keychainService?: string;
  keychainAccount?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function smtpProfileSpecs(env: NodeJS.ProcessEnv): SmtpProfileSpec[] {
  const specs: SmtpProfileSpec[] = [];
  const legacyHost = optionalString(env[SMTP_ENV.host]);
  const legacyUser = optionalString(env[SMTP_ENV.user]);
  if (legacyHost && legacyUser) {
    specs.push({
      host: legacyHost,
      port: env[SMTP_ENV.port] ? Number.parseInt(env[SMTP_ENV.port] as string, 10) : undefined,
      secure: /^(1|true|yes)$/i.test(env[SMTP_ENV.secure]?.trim() ?? ""),
      user: legacyUser,
      from: optionalString(env[SMTP_ENV.from]),
      allowedFrom: (env[SMTP_ENV.allowedFrom] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      password: env[SMTP_ENV.password],
      keychainService: optionalString(env[SMTP_ENV.keychainService]),
      keychainAccount: optionalString(env[SMTP_ENV.keychainAccount]),
    });
  }

  const json = env[SMTP_ENV.accounts]?.trim();
  if (!json) return specs;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${SMTP_ENV.accounts} must be a valid JSON array.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${SMTP_ENV.accounts} must be a JSON array.`);
  }
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const profile = raw as Record<string, unknown>;
    const host = optionalString(profile.host);
    const user = optionalString(profile.user);
    if (!host || !user) continue;
    const allowedFrom = Array.isArray(profile.allowedFrom)
      ? profile.allowedFrom.map(optionalString).filter((value): value is string => Boolean(value))
      : optionalString(profile.allowedFrom)
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean);
    specs.push({
      account: optionalString(profile.account) ?? optionalString(profile.accountLabel),
      host,
      port: profile.port === undefined ? undefined : Number(profile.port),
      secure:
        typeof profile.secure === "boolean"
          ? profile.secure
          : /^(1|true|yes)$/i.test(optionalString(profile.secure) ?? ""),
      user,
      from: optionalString(profile.from),
      allowedFrom,
      password: optionalString(profile.password),
      keychainService: optionalString(profile.keychainService),
      keychainAccount: optionalString(profile.keychainAccount),
    });
  }
  return specs;
}

function resolveSmtpProfile(spec: SmtpProfileSpec): SmtpConfig {
  const secure = spec.secure ?? false;
  const port = spec.port ?? (secure ? 465 : 587);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid SMTP port "${String(spec.port)}" for "${spec.account ?? spec.user}".`);
  }
  const from = spec.from ?? spec.user;
  let pass = spec.password;
  if (!pass) {
    pass =
      readKeychainPassword(spec.keychainService ?? spec.host, spec.keychainAccount ?? spec.user) ??
      undefined;
  }
  if (!pass) {
    throw new Error(
      `No SMTP password found for "${spec.account ?? spec.user}". Configure a Keychain service/account or password.`
    );
  }
  return {
    host: spec.host,
    port,
    secure,
    user: spec.user,
    pass,
    from,
    allowedFrom: spec.allowedFrom ?? [],
  };
}

/**
 * Resolve the transport profile authorized for one concrete sending identity.
 * Email aliases are matched against user/from/allowedFrom; account is used as a
 * secondary disambiguator. Ambiguous or unavailable identities are rejected.
 */
export function resolveSmtpConfigForIdentity(
  identity: { email?: string; account?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): SmtpConfig {
  const specs = smtpProfileSpecs(env);
  if (specs.length === 0) return resolveSmtpConfig(env);
  const email = identity.email?.trim().toLowerCase();
  const account = identity.account?.trim().toLowerCase();
  let candidates = specs;
  if (email) {
    const emailMatches = specs.filter((spec) =>
      [spec.user, spec.from ?? spec.user, ...(spec.allowedFrom ?? [])]
        .map((value) => value.toLowerCase())
        .includes(email)
    );
    if (emailMatches.length > 0) candidates = emailMatches;
    else {
      throw new Error(`No SMTP transport profile authorizes From "${identity.email}".`);
    }
  }
  if (account && candidates.length > 1) {
    const accountMatches = candidates.filter((spec) => spec.account?.toLowerCase() === account);
    if (accountMatches.length > 0) candidates = accountMatches;
  }
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? "No SMTP transport profile matched the selected identity."
        : `SMTP transport is ambiguous for "${identity.email ?? identity.account ?? "default"}"; configure distinct account/from mappings.`
    );
  }
  return resolveSmtpProfile(candidates[0]);
}

/**
 * Validates attachment paths the same way the AppleScript path does: absolute
 * and existing. Returns nodemailer attachment descriptors.
 */
function buildAttachments(attachments?: AttachmentInput[]) {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => {
    if (typeof a === "string") {
      if (!isAbsolute(a)) throw new Error(`Attachment path must be absolute: "${a}"`);
      if (!existsSync(a)) throw new Error(`Attachment file not found: "${a}"`);
      return { path: a };
    }
    if (!a.filename || !a.contentBase64) {
      throw new Error("Inline attachment requires both filename and contentBase64.");
    }
    return { filename: a.filename, content: decodeInlineAttachment(a.contentBase64) };
  });
}

/**
 * Sends an email over SMTP, producing clean MIME with no blockquote wrapping.
 *
 * Config is resolved via {@link resolveSmtpConfig} unless one is injected (the
 * `config` parameter exists for testing). The body is sent as plain text; pass
 * a transporter factory only in tests.
 */
export async function sendViaSmtp(
  opts: SmtpSendOptions,
  config?: SmtpConfig,
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport
): Promise<SmtpSendResult> {
  let cfg: SmtpConfig;
  try {
    cfg = config ?? resolveSmtpConfig();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const requestedFrom = opts.from?.trim();
  const allowedFrom = new Set(
    [cfg.user, cfg.from, ...(cfg.allowedFrom ?? [])].map((value) => value.trim().toLowerCase())
  );
  if (requestedFrom && !allowedFrom.has(requestedFrom.toLowerCase())) {
    return {
      success: false,
      error: `SMTP From "${requestedFrom}" is not a configured sender identity.`,
    };
  }

  let attachments;
  try {
    attachments = buildAttachments(opts.attachments);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const transporter = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const html = opts.htmlBody?.trim() ? opts.htmlBody : undefined;

  try {
    const info = await transporter.sendMail({
      from: requestedFrom || cfg.from,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.body,
      // When present, nodemailer emits multipart/alternative (text + html).
      html,
      attachments,
      // RFC 5322 threading for SMTP replies/forwards (2.5.0).
      inReplyTo: opts.inReplyTo?.trim() || undefined,
      references: opts.references?.length ? opts.references : undefined,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const responseCode =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { responseCode?: unknown }).responseCode === "number"
        ? (error as { responseCode: number }).responseCode
        : undefined;
    return {
      success: false,
      error: `SMTP send failed: ${error instanceof Error ? error.message : String(error)}`,
      uncertain: responseCode === undefined,
    };
  } finally {
    transporter.close();
  }
}

function senderAddress(value: string): string {
  const angle = value.match(/<([^<>]+)>/);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

/**
 * Submit an already-composed RFC 5322 message without rebuilding its MIME.
 * The caller supplies the SMTP envelope separately so Bcc can be omitted from
 * delivered headers while those recipients still receive the message.
 */
export async function sendRawViaSmtp(
  raw: Buffer,
  envelope: RawSmtpEnvelope,
  config: SmtpConfig,
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport
): Promise<SmtpSendResult> {
  const requestedFrom = senderAddress(envelope.from);
  const allowedFrom = new Set(
    [config.user, config.from, ...(config.allowedFrom ?? [])].map(senderAddress)
  );
  if (!allowedFrom.has(requestedFrom)) {
    return {
      success: false,
      error: `SMTP From "${envelope.from}" is not a configured sender identity.`,
    };
  }
  if (envelope.to.length === 0) {
    return { success: false, error: "SMTP envelope has no recipients." };
  }

  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  try {
    const info = await transporter.sendMail({
      envelope: { from: requestedFrom, to: envelope.to },
      raw,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const responseCode =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { responseCode?: unknown }).responseCode === "number"
        ? (error as { responseCode: number }).responseCode
        : undefined;
    return {
      success: false,
      error: `SMTP send failed: ${error instanceof Error ? error.message : String(error)}`,
      uncertain: responseCode === undefined,
    };
  } finally {
    transporter.close();
  }
}

/** One recipient of a mail-merge batch (mirrors the AppleScript serial path). */
export interface SerialSmtpRecipient {
  email: string;
  variables: Record<string, string>;
}

/** Per-recipient outcome of a serial SMTP send. */
export interface SerialSmtpResult {
  email: string;
  success: boolean;
  error?: string;
}

/**
 * Replace every `{{Key}}` token in `template` with the matching value from
 * `variables`. Keys are escaped so regex metacharacters in a key are literal.
 * Mirrors the substitution in {@link AppleMailManager.sendSerialEmail} so the
 * two transports personalize identically.
 */
export function applyPlaceholders(template: string, variables: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(variables)) {
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\{\\{${safeKey}\\}\\}`, "g"), value);
  }
  return out;
}

/**
 * Send a personalized mail-merge batch over SMTP — one individual message per
 * recipient (recipients never see each other), with `{{Key}}` placeholders in
 * the subject/body replaced per recipient. Returns a per-recipient result list;
 * a single recipient's failure does not abort the batch.
 *
 * `opts.send` and `opts.sleep` are injectable for tests (no real SMTP / no real
 * delay). The default `sleep` waits `delayMs` (clamped 0–10000) between sends.
 */
export async function sendSerialViaSmtp(
  recipients: SerialSmtpRecipient[],
  subject: string,
  body: string,
  config: SmtpConfig,
  opts: {
    delayMs?: number;
    /** Exact configured alias to use for every personalized message. */
    from?: string;
    send?: typeof sendViaSmtp;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<SerialSmtpResult[]> {
  const send = opts.send ?? sendViaSmtp;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = Math.min(Math.max(opts.delayMs ?? 500, 0), 10000);

  const results: SerialSmtpResult[] = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    try {
      const res = await send(
        {
          to: [r.email],
          subject: applyPlaceholders(subject, r.variables),
          body: applyPlaceholders(body, r.variables),
          from: opts.from ?? config.from,
        },
        config
      );
      results.push({ email: r.email, success: res.success, error: res.error });
    } catch (error) {
      results.push({
        email: r.email,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (delay > 0 && i < recipients.length - 1) {
      await sleep(delay);
    }
  }
  return results;
}
