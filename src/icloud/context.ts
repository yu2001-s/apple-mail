import nodemailer from "nodemailer";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadFileConfig } from "../services/fileConfig.js";
import { ImapFlow } from "../services/imapFlow.js";
import { resolveImapConfig, decodeImapId, type ImapDeps } from "../services/imapClient.js";
import { resolveSmtpConfig, sendRawViaSmtp } from "../services/smtpMailer.js";
import { ImapDraftManager } from "../services/imapDraftManager.js";
import type { SendingIdentity } from "../types.js";

export type Preferences = {
  primaryAddress?: string;
  signatures?: Record<string, string>;
};

/** Everything the tools share, whichever transport serves them. */
export interface ConnectorContext {
  dataDirectory: string;
  account: string;
  addresses: string[];
  defaultFrom: string;
  preferences: Preferences;
  drafts: ImapDraftManager;
  /** Passed to every pooled IMAP operation. */
  imapDeps: ImapDeps;
  tlsTransport: typeof nodemailer.createTransport;
  withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T>;
  checkId(id: string): void;
  /** Serialize every mail operation, across all sessions of this process. */
  serialize<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ContextOptions {
  /** Preferences supplied directly instead of read from the data directory. */
  preferences?: Preferences;
  /** Draft cache file; `null` keeps it in memory. Defaults to the data directory. */
  registryPath?: string | null;
  /** Supplies IMAP connections, e.g. one reused for a whole request. */
  connect?: ImapDeps["connect"];
  /** Read the account configuration file into `env` (local installs). */
  fileConfig?: boolean;
}

export function loadContext(
  env: NodeJS.ProcessEnv = process.env,
  options: ContextOptions = {}
): ConnectorContext {
  if (options.fileConfig !== false) loadFileConfig(env);
  const dataDirectory =
    env.ICLOUD_MAIL_DATA_DIR ||
    (options.preferences ? "" : join(homedir(), ".codex/integrations/icloud-mail"));
  const account = env.APPLE_MAIL_MCP_IMAP_ACCOUNT || env.APPLE_MAIL_MCP_IMAP_USER;
  if (
    env.APPLE_MAIL_MCP_IMAP_HOST !== "imap.mail.me.com" ||
    env.APPLE_MAIL_MCP_SMTP_HOST !== "smtp.mail.me.com" ||
    !account
  ) {
    throw new Error("Expected the existing iCloud IMAP/SMTP configuration.");
  }
  const addresses = [
    ...new Set(
      [
        env.APPLE_MAIL_MCP_SMTP_USER,
        env.APPLE_MAIL_MCP_SMTP_FROM,
        ...(env.APPLE_MAIL_MCP_SMTP_ALLOWED_FROM || "").split(","),
      ]
        .filter(Boolean)
        .map((x) => x!.trim())
        .filter(Boolean)
    ),
  ];
  const preferences: Preferences =
    options.preferences ??
    JSON.parse(readFileSync(join(dataDirectory, "preferences.json"), "utf8"));
  const preferredAddress = addresses.find(
    (address) => address.toLowerCase() === preferences.primaryAddress?.toLowerCase()
  );
  if (!preferredAddress) {
    throw new Error("The primary address must be a configured sending address.");
  }
  const defaultFrom: string = preferredAddress;
  function identity(selector?: string): SendingIdentity | null {
    const email = addresses.find(
      (x) => x.toLowerCase() === (selector ?? defaultFrom).toLowerCase()
    );
    return email
      ? {
          identityId: email,
          email,
          sender: email,
          fullName: "",
          accountId: account!,
          accountName: account!,
          enabled: true,
          isDefault: email === defaultFrom,
        }
      : null;
  }
  const tlsTransport = ((options: any) =>
    nodemailer.createTransport({
      ...options,
      requireTLS: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      logger: false,
      debug: false,
    })) as typeof nodemailer.createTransport;
  const imapDeps: ImapDeps = { account, connect: options.connect };
  const drafts = new ImapDraftManager({
    registryPath:
      options.registryPath === undefined
        ? join(dataDirectory, "drafts.json")
        : options.registryPath,
    imapDeps: () => imapDeps,
    resolveIdentity: identity,
    imapAccount: () => account,
    selfAddresses: addresses,
    smtpConfig: (id) => ({ ...resolveSmtpConfig(env), from: id.email }),
    smtpSend: (raw, envelope, config) => sendRawViaSmtp(raw, envelope, config, tlsTransport),
  });
  async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const cfg = resolveImapConfig(env, account);
    if (options.connect) {
      // The supplier owns the connection's lifetime.
      return fn((await options.connect(cfg)) as unknown as ImapFlow);
    }
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: true,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      return await fn(client);
    } finally {
      try {
        await client.logout();
      } catch {
        /* The connection may already be closed. */
      }
      client.close();
    }
  }
  function checkId(id: string) {
    const ref = decodeImapId(id);
    if (!ref || ref.account !== account || !Number.isSafeInteger(ref.uid) || ref.uid < 1) {
      throw new Error("Use a message ID returned by this iCloud connector.");
    }
  }
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  return {
    dataDirectory,
    account,
    addresses,
    defaultFrom,
    preferences,
    drafts,
    imapDeps,
    tlsTransport,
    withImap,
    checkId,
    serialize,
  };
}
