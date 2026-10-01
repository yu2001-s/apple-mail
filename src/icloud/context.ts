import nodemailer from "nodemailer";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadFileConfig } from "../services/fileConfig.js";
import { ImapFlow } from "../services/imapFlow.js";
import { resolveImapConfig, decodeImapId, type ImapDeps } from "../services/imapClient.js";
import { resolveSmtpConfig, sendRawViaSmtp } from "../services/smtpMailer.js";
import { ImapDraftManager } from "../services/imapDraftManager.js";
import type { SendingIdentity } from "../types.js";
import {
  FileSettingsStore,
  sameAddress,
  seedSettings,
  type Settings,
  type SettingsStore,
} from "./settings.js";

export type Preferences = {
  primaryAddress?: string;
  signatures?: Record<string, string>;
};

/** Everything the tools share, whichever transport serves them. */
export interface ConnectorContext {
  dataDirectory: string;
  account: string;
  /** The current settings; reload with refresh() before relying on them. */
  settings: Settings;
  /** Reload settings from the store, seeding it on first use. */
  refresh(): Promise<Settings>;
  /** Persist new settings and use them for the rest of this context. */
  saveSettings(next: Settings): Promise<void>;
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
  /** Seed preferences supplied directly instead of read from the data directory. */
  preferences?: Preferences;
  /** Where settings live. Defaults to settings.json in the data directory. */
  settingsStore?: SettingsStore;
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
  const preferencesPath = join(dataDirectory, "preferences.json");
  const preferences: Preferences =
    options.preferences ??
    (existsSync(preferencesPath) ? JSON.parse(readFileSync(preferencesPath, "utf8")) : {});
  const seed = seedSettings(env, preferences);
  const store =
    options.settingsStore ?? new FileSettingsStore(join(dataDirectory, "settings.json"));
  let settings = seed;
  function senderFor(selector?: string): string | undefined {
    return settings.addresses.find((x) => sameAddress(x, selector ?? settings.primaryAddress));
  }
  function identity(selector?: string): SendingIdentity | null {
    const email = senderFor(selector);
    return email
      ? {
          identityId: email,
          email,
          sender: email,
          fullName: "",
          accountId: account!,
          accountName: account!,
          enabled: true,
          isDefault: sameAddress(email, settings.primaryAddress),
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
    selfAddresses: () => settings.addresses,
    smtpConfig: (id) => {
      // Re-checked at send time: a draft may predate the sender's removal.
      const from = senderFor(id.email);
      if (!from) throw new Error(`"${id.email}" is no longer a sending address.`);
      return { ...resolveSmtpConfig(env), from, allowedFrom: [...settings.addresses] };
    },
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
  const ctx: ConnectorContext = {
    dataDirectory,
    account,
    get settings() {
      return settings;
    },
    async refresh() {
      const stored = await store.load();
      if (stored) settings = stored;
      else await store.save((settings = seed));
      return settings;
    },
    async saveSettings(next) {
      await store.save(next);
      settings = next;
    },
    drafts,
    imapDeps,
    tlsTransport,
    withImap,
    checkId,
    serialize,
  };
  return ctx;
}
