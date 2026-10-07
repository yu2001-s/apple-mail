/**
 * Linked Google accounts: their sealed refresh tokens in storage, access
 * tokens cached in memory, and authenticated calls to Google's REST APIs.
 */
import { open, seal } from "./crypto.js";
import {
  CALENDAR_SCOPE,
  GMAIL_SCOPE,
  GoogleReconnectError,
  refreshAccessToken,
  revokeToken,
  type Fetch,
  type GoogleClientConfig,
  type LinkedTokens,
} from "./oauth.js";

export type GoogleService = "gmail" | "calendar";

const SERVICE_SCOPES: Record<GoogleService, string> = {
  gmail: GMAIL_SCOPE,
  calendar: CALENDAR_SCOPE,
};
const SERVICE_NAMES: Record<GoogleService, string> = { gmail: "Gmail", calendar: "Calendar" };

/** Refresh access tokens this long before Google expires them. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** Gmail recommends at most 50 calls per batch. */
const BATCH_SIZE = 50;

export interface StoredGoogleAccount {
  email: string;
  sub: string;
  scopes: string[];
  addedAt: string;
  /** Sealed with CONNECTOR_SECRET_KEY, bound to `email`. */
  refreshToken: string;
}

export interface GoogleAccountStore {
  load(): Promise<StoredGoogleAccount[]>;
  save(accounts: StoredGoogleAccount[]): Promise<void>;
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Linked accounts kept as one document in Workers KV. */
export function kvGoogleAccountStore(kv: KvLike, key = "google-accounts:v1"): GoogleAccountStore {
  return {
    async load() {
      const raw = await kv.get(key);
      if (raw === null) return [];
      const doc = JSON.parse(raw) as { version?: number; accounts?: StoredGoogleAccount[] };
      if (doc.version !== 1 || !Array.isArray(doc.accounts)) {
        throw new Error("Stored Google accounts are invalid.");
      }
      return doc.accounts;
    },
    async save(accounts) {
      await kv.put(key, JSON.stringify({ version: 1, accounts }));
    },
  };
}

export interface GoogleAccountSummary {
  email: string;
  services: GoogleService[];
  addedAt: string;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface BatchRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path and query relative to the API host, e.g. /gmail/v1/users/me/threads/abc. */
  path: string;
  body?: unknown;
}

export interface BatchResponse {
  status: number;
  body: any;
}

export interface GoogleAccountsOptions {
  config: GoogleClientConfig;
  store: GoogleAccountStore;
  key: Promise<CryptoKey>;
  /** Where the owner links and removes accounts, for error messages. */
  manageUrl?: string;
  fetch?: Fetch;
  now?: () => number;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class GoogleAccounts {
  manageUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly options: GoogleAccountsOptions) {
    this.manageUrl = options.manageUrl ?? "/accounts";
    // Workers require fetch to be called unbound from its global.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** The linked accounts, read fresh from storage. */
  accounts(): Promise<StoredGoogleAccount[]> {
    return this.options.store.load();
  }

  async summaries(): Promise<GoogleAccountSummary[]> {
    return (await this.accounts()).map((account) => ({
      email: account.email,
      services: (Object.keys(SERVICE_SCOPES) as GoogleService[]).filter((service) =>
        account.scopes.includes(SERVICE_SCOPES[service])
      ),
      addedAt: account.addedAt,
    }));
  }

  /** Add an account, or replace the tokens of one linked before. */
  async link(tokens: LinkedTokens): Promise<void> {
    const key = await this.options.key;
    const accounts = (await this.accounts()).filter(
      (account) => !same(account.email, tokens.email)
    );
    accounts.push({
      email: tokens.email,
      sub: tokens.sub,
      scopes: tokens.scopes,
      addedAt: new Date(this.now()).toISOString(),
      refreshToken: await seal(key, tokens.refreshToken, tokens.email),
    });
    accounts.sort((a, b) => a.email.localeCompare(b.email));
    await this.options.store.save(accounts);
    this.tokens.set(tokens.email, {
      token: tokens.accessToken,
      expiresAt: this.now() + tokens.expiresIn * 1000,
    });
  }

  /** Remove an account and revoke its access at Google. */
  async unlink(email: string): Promise<boolean> {
    const accounts = await this.accounts();
    const found = accounts.find((account) => same(account.email, email));
    if (!found) return false;
    await this.options.store.save(accounts.filter((account) => account !== found));
    this.tokens.delete(found.email);
    const refreshToken = await open(await this.options.key, found.refreshToken, found.email).catch(
      () => undefined
    );
    if (refreshToken) await revokeToken(refreshToken, this.fetchImpl);
    return true;
  }

  /** The one account a call addresses: `account`, or the only account with the service. */
  async resolve(account: string | undefined, service: GoogleService): Promise<string> {
    const [email] = await this.resolveAll(account, service, true);
    return email;
  }

  /** `account` alone, or every linked account that granted the service. */
  async resolveAll(
    account: string | undefined,
    service: GoogleService,
    single = false
  ): Promise<string[]> {
    const accounts = await this.accounts();
    if (!accounts.length) {
      throw new Error(`No Google account is linked. The user can link one at ${this.manageUrl}.`);
    }
    const scope = SERVICE_SCOPES[service];
    if (account) {
      const found = accounts.find((item) => same(item.email, account));
      if (!found) {
        throw new Error(
          `"${account}" is not a linked Google account. Linked: ${accounts.map((a) => a.email).join(", ")}.`
        );
      }
      if (!found.scopes.includes(scope)) {
        throw new Error(
          `${found.email} did not grant ${SERVICE_NAMES[service]} access. The user can link it again at ${this.manageUrl} and allow it.`
        );
      }
      return [found.email];
    }
    const usable = accounts.filter((item) => item.scopes.includes(scope)).map((a) => a.email);
    if (!usable.length) {
      throw new Error(
        `No linked Google account granted ${SERVICE_NAMES[service]} access. The user can link one at ${this.manageUrl}.`
      );
    }
    if (single && usable.length > 1) {
      throw new Error(
        `Several Google accounts are linked; pass account as one of: ${usable.join(", ")}.`
      );
    }
    return usable;
  }

  /** A current access token, refreshed when within five minutes of expiry. */
  async accessToken(email: string): Promise<string> {
    const cached = this.tokens.get(email);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) return cached.token;
    let pending = this.refreshing.get(email);
    if (!pending) {
      pending = this.refresh(email).finally(() => this.refreshing.delete(email));
      this.refreshing.set(email, pending);
    }
    return pending;
  }

  private async refresh(email: string): Promise<string> {
    const account = (await this.accounts()).find((item) => same(item.email, email));
    if (!account) throw new Error(`"${email}" is no longer a linked Google account.`);
    const refreshToken = await open(await this.options.key, account.refreshToken, account.email);
    try {
      const { accessToken, expiresIn } = await refreshAccessToken(
        this.options.config,
        refreshToken,
        this.fetchImpl
      );
      this.tokens.set(email, { token: accessToken, expiresAt: this.now() + expiresIn * 1000 });
      return accessToken;
    } catch (error) {
      if (error instanceof GoogleReconnectError) {
        throw new Error(
          `Google no longer accepts the saved access for ${email} (${error.message}). The user can link it again at ${this.manageUrl}.`
        );
      }
      throw error;
    }
  }

  /** An authenticated request; a rejected access token is refreshed once. */
  async send(email: string, url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async () =>
      this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          Authorization: `Bearer ${await this.accessToken(email)}`,
        },
      });
    let response = await attempt();
    if (response.status === 401) {
      this.tokens.delete(email);
      response = await attempt();
    }
    return response;
  }

  /** A JSON request; Google's error message is raised for non-2xx responses. */
  async request<T = any>(
    email: string,
    url: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}
  ): Promise<T> {
    const response = await this.send(email, url, {
      method: init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body !== undefined && { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw this.apiError(email, response.status, data);
    return data as T;
  }

  apiError(email: string, status: number, data: any): GoogleApiError {
    const message: string = data?.error?.message ?? data?.error_description ?? `HTTP ${status}`;
    if (status === 403 && /insufficient|scope/i.test(message)) {
      return new GoogleApiError(
        `${email} did not grant this access. The user can link it again at ${this.manageUrl} and allow it.`,
        status
      );
    }
    return new GoogleApiError(`Google API error ${status} for ${email}: ${message}`, status);
  }

  /**
   * Run many GET-style calls as Google batch requests: one subrequest per 50
   * calls, which keeps multi-account searches within Workers' limits.
   */
  async batch(email: string, endpoint: string, requests: BatchRequest[]): Promise<BatchResponse[]> {
    const results: BatchResponse[] = [];
    for (let start = 0; start < requests.length; start += BATCH_SIZE) {
      const chunk = requests.slice(start, start + BATCH_SIZE);
      const boundary = `batch_${crypto.randomUUID()}`;
      const response = await this.send(email, endpoint, {
        method: "POST",
        headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
        body: batchBody(boundary, chunk),
      });
      const text = await response.text();
      if (!response.ok) {
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }
        throw this.apiError(email, response.status, data);
      }
      results.push(
        ...parseBatchResponse(response.headers.get("content-type") ?? "", text, chunk.length)
      );
    }
    return results;
  }
}

export function batchBody(boundary: string, requests: BatchRequest[]): string {
  const parts = requests.map((request, index) => {
    const head = `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${index}>\r\n\r\n${request.method} ${request.path}\r\n`;
    return request.body === undefined
      ? `${head}\r\n`
      : `${head}Content-Type: application/json\r\n\r\n${JSON.stringify(request.body)}\r\n`;
  });
  return `${parts.join("")}--${boundary}--\r\n`;
}

/** Split a multipart/mixed batch response into per-call results, in request order. */
export function parseBatchResponse(
  contentType: string,
  text: string,
  count: number
): BatchResponse[] {
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  const results: BatchResponse[] = Array.from({ length: count }, () => ({
    status: 500,
    body: { error: { message: "Missing from Google's batch response." } },
  }));
  if (!boundary) return results;
  for (const part of text.split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const id = part.match(/Content-ID:\s*<response-item(\d+)>/i)?.[1];
    const status = part.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
    if (id === undefined || !status || Number(id) >= count) continue;
    const afterStatus = part.slice((status.index ?? 0) + status[0].length);
    const separator = afterStatus.search(/\r?\n\r?\n/);
    const raw = separator < 0 ? "" : afterStatus.slice(separator).trim();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { error: { message: raw.slice(0, 200) } };
      }
    }
    results[Number(id)] = { status: Number(status[1]), body };
  }
  return results;
}
