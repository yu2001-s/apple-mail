/**
 * A single-owner OAuth 2.1 authorization server for the remote connector.
 *
 * Any MCP client may register (claude.ai requires dynamic client
 * registration), but only someone who knows the owner password can approve
 * it. Tokens are random, stored hashed, and bound to this server's resource.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { isAllowedRedirect } from "./redirects.js";

export const MAIL_SCOPE = "mail";
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_CLIENTS = 50;
const MAX_PENDING = 50;
/** Failed approvals tolerated per window before approval locks entirely. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60 * 60 * 1000;

interface StoredToken {
  kind: "access" | "refresh";
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface Store {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  /** Keyed by the SHA-256 of the token; raw tokens are never written. */
  tokens: Record<string, StoredToken>;
}

interface PendingAuthorization {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface OwnerOAuthOptions {
  storePath: string;
  ownerPassword: string;
  /** The protected MCP endpoint, e.g. https://mail.example.com/mcp. */
  resourceUrl: URL;
  /** Exact redirect URIs accepted at registration, besides the built-in ones. */
  redirectUris?: string[];
  now?: () => number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hashToken(token: string): string {
  return digest(token).toString("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeResource(url: URL | string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  private readonly options: OwnerOAuthOptions;
  private readonly resource: string;
  private readonly redirectUris: string[];
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private failures: number[] = [];

  constructor(options: OwnerOAuthOptions) {
    if (options.ownerPassword.length < 16) {
      throw new Error("The owner password must be at least 16 characters.");
    }
    this.options = options;
    this.resource = normalizeResource(options.resourceUrl);
    this.redirectUris = options.redirectUris ?? [];
    this.now = options.now ?? Date.now;
  }

  private load(): Store {
    if (!existsSync(this.options.storePath)) return { version: 1, clients: {}, tokens: {} };
    const parsed = JSON.parse(readFileSync(this.options.storePath, "utf8")) as Store;
    if (parsed.version !== 1) throw new Error("Unsupported OAuth store format.");
    return parsed;
  }

  private save(store: Store): void {
    const nowS = Math.floor(this.now() / 1000);
    for (const [key, token] of Object.entries(store.tokens)) {
      if (token.expiresAt <= nowS) delete store.tokens[key];
    }
    mkdirSync(dirname(this.options.storePath), { recursive: true });
    const tmp = `${this.options.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.options.storePath);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.load().clients[clientId],
      registerClient: (client) => {
        const uris = client.redirect_uris.map(String);
        const rejected = uris.find((uri) => !isAllowedRedirect(uri, this.redirectUris));
        if (rejected) {
          throw new InvalidClientMetadataError(`Redirect URI is not allowed: ${rejected}`);
        }
        const store = this.load();
        const full = client as OAuthClientInformationFull;
        store.clients[full.client_id] = full;
        // Bound registrations: drop the oldest clients that hold no tokens.
        const active = new Set(Object.values(store.tokens).map((t) => t.clientId));
        const idle = Object.values(store.clients)
          .filter((c) => !active.has(c.client_id) && c.client_id !== full.client_id)
          .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
        while (Object.keys(store.clients).length > MAX_CLIENTS && idle.length) {
          delete store.clients[idle.shift()!.client_id];
        }
        this.save(store);
        return full;
      },
    };
  }

  private checkResource(resource: URL | string | undefined): string {
    if (resource && normalizeResource(resource) !== this.resource) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resource}.`);
    }
    return this.resource;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key);
    this.failures = this.failures.filter((at) => at > now - FAILURE_WINDOW_MS);
  }

  /** Show the owner approval page; the decision is posted to /oauth/approve. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    this.sweep();
    const target = new URL(params.redirectUri);
    try {
      this.checkResource(params.resource);
    } catch {
      target.searchParams.set("error", "invalid_target");
      if (params.state) target.searchParams.set("state", params.state);
      res.redirect(302, target.href);
      return;
    }
    while (this.pending.size >= MAX_PENDING) {
      this.pending.delete(this.pending.keys().next().value!);
    }
    const requestId = newSecret();
    this.pending.set(requestId, {
      clientId: client.client_id,
      params,
      expiresAt: this.now() + REQUEST_TTL_MS,
    });
    const name = escapeHtml(client.client_name || client.client_id);
    const destination = escapeHtml(target.origin);
    res.status(200).set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${target.origin}; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    }).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize iCloud Mail</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f}}
input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}
.row{display:flex;flex-direction:row-reverse;gap:.5rem}code{word-break:break-all}</style></head>
<body><h1>Authorize iCloud Mail</h1>
<p><strong>${name}</strong> is requesting access to read, draft and send mail from this account.</p>
<p>After approval you will return to <code>${destination}</code>.</p>
<form method="post" action="/oauth/approve">
<input type="hidden" name="request_id" value="${requestId}">
<label>Owner password<input type="password" name="password" autocomplete="current-password" autofocus></label>
<div class="row"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></div>
</form></body></html>`);
  }

  /**
   * Complete a pending authorization: the client's redirect target on approval
   * or denial, otherwise an error page for an unknown request, a wrong
   * password, or approvals locked after repeated failures.
   */
  approve(
    requestId: string,
    password: string,
    decision: string
  ): { redirect: string } | { error: string; status: number } {
    this.sweep();
    const request = this.pending.get(requestId);
    if (!request) return { error: "This authorization request expired. Start again.", status: 400 };
    const target = new URL(request.params.redirectUri);
    if (request.params.state) target.searchParams.set("state", request.params.state);
    if (decision !== "approve") {
      this.pending.delete(requestId);
      target.searchParams.set("error", "access_denied");
      return { redirect: target.href };
    }
    if (this.failures.length >= MAX_FAILURES) {
      return { error: "Too many failed attempts. Try again later.", status: 429 };
    }
    if (!timingSafeEqual(digest(password), digest(this.options.ownerPassword))) {
      this.failures.push(this.now());
      return { error: "Incorrect owner password.", status: 401 };
    }
    this.pending.delete(requestId);
    const code = newSecret();
    this.codes.set(code, {
      clientId: request.clientId,
      codeChallenge: request.params.codeChallenge,
      redirectUri: request.params.redirectUri,
      scopes: [MAIL_SCOPE],
      resource: this.resource,
      expiresAt: this.now() + CODE_TTL_MS,
    });
    target.searchParams.set("code", code);
    return { redirect: target.href };
  }

  private liveCode(client: OAuthClientInformationFull, code: string): AuthorizationCode {
    this.sweep();
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return entry;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    return this.liveCode(client, authorizationCode).codeChallenge;
  }

  private issue(store: Store, clientId: string, scopes: string[]): OAuthTokens {
    const nowS = Math.floor(this.now() / 1000);
    const accessToken = newSecret();
    const refreshToken = newSecret();
    const base = { clientId, scopes, resource: this.resource };
    store.tokens[hashToken(accessToken)] = {
      ...base,
      kind: "access",
      expiresAt: nowS + ACCESS_TTL_S,
    };
    store.tokens[hashToken(refreshToken)] = {
      ...base,
      kind: "refresh",
      expiresAt: nowS + REFRESH_TTL_S,
    };
    this.save(store);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const entry = this.liveCode(client, authorizationCode);
    // Codes are single use, even when the exchange below is rejected.
    this.codes.delete(authorizationCode);
    if (redirectUri && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    this.checkResource(resource);
    return this.issue(this.load(), client.client_id, entry.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    const store = this.load();
    const key = hashToken(refreshToken);
    const entry = store.tokens[key];
    if (
      !entry ||
      entry.kind !== "refresh" ||
      entry.clientId !== client.client_id ||
      entry.expiresAt <= Math.floor(this.now() / 1000)
    ) {
      throw new InvalidGrantError("Invalid or expired refresh token.");
    }
    if (scopes?.some((scope) => !entry.scopes.includes(scope))) {
      throw new InvalidGrantError("A refresh cannot widen the granted scope.");
    }
    // Rotate: the presented refresh token is consumed.
    delete store.tokens[key];
    return this.issue(store, client.client_id, scopes?.length ? scopes : entry.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.load().tokens[hashToken(token)];
    if (
      !entry ||
      entry.kind !== "access" ||
      entry.resource !== this.resource ||
      entry.expiresAt <= Math.floor(this.now() / 1000)
    ) {
      throw new InvalidTokenError("Invalid or expired access token.");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt,
      resource: new URL(entry.resource),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const store = this.load();
    const key = hashToken(request.token);
    if (store.tokens[key]?.clientId === client.client_id) {
      delete store.tokens[key];
      this.save(store);
    }
  }
}
