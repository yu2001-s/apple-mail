/**
 * Cloudflare Worker deployment of the iCloud Mail connector.
 *
 * The Worker is its own OAuth 2.1 authorization server (dynamic registration
 * for Claude, Client ID Metadata Documents for ChatGPT) and serves MCP over
 * stateless Streamable HTTP at /mcp. Each request builds a fresh connector
 * context: the iCloud Drafts mailbox and its send markers hold all durable
 * draft state, so nothing but OAuth data needs Worker storage.
 */
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { connectImap, type ImapClientLike, type ImapConnect } from "../services/imapClient.js";
import { loadContext, type Preferences } from "../icloud/context.js";
import { formActionSources, isAllowedRedirect, parseRedirectList } from "../icloud/redirects.js";
import { createMcpServer } from "../icloud/tools.js";
import { consentPage, messagePage, retryPage } from "./consent.js";

const MAIL_SCOPE = "mail";
const MAX_FAILURES = 10;
const FAILURE_WINDOW_S = 60 * 60;

interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  OAUTH_KV: KV;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Approves each OAuth connection. Secret, at least 16 characters. */
  ICLOUD_MAIL_OWNER_PASSWORD?: string;
  /** preferences.json content: primary address and signatures. Secret. */
  ICLOUD_MAIL_PREFERENCES?: string;
  /** Optional canonical origin when the Worker answers on several hostnames. */
  ICLOUD_MAIL_PUBLIC_URL?: string;
  ICLOUD_MAIL_OAUTH_REDIRECT_URIS?: string;
  [key: string]: unknown;
}

/** Copy string bindings (vars and secrets) into process.env for the shared modules. */
function syncProcessEnv(env: Env): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") process.env[key] = value;
  }
  return process.env;
}

/**
 * One IMAP connection per request. Worker I/O objects cannot outlive or be
 * shared across requests, so the module-level pool is bypassed; operations
 * within a request reuse the connection and it is logged out at the end.
 */
function requestImap() {
  let shared: Promise<ImapClientLike> | undefined;
  const connect: ImapConnect = async (cfg) => {
    shared ??= connectImap(cfg);
    const client = await shared;
    return new Proxy(client, {
      get(target, property) {
        if (property === "logout") return async () => undefined;
        if (property === "close") return () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const end = async () => {
    const client = await shared?.catch(() => undefined);
    await client?.logout().catch(() => undefined);
    client?.close?.();
  };
  return { connect, end };
}

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: WaitUntil): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { status: 405, headers: { Allow: "POST" } }
      );
    }
    if (!env.ICLOUD_MAIL_PREFERENCES) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "ICLOUD_MAIL_PREFERENCES is not configured." },
          id: null,
        },
        { status: 500 }
      );
    }
    const imap = requestImap();
    const context = loadContext(syncProcessEnv(env), {
      preferences: JSON.parse(env.ICLOUD_MAIL_PREFERENCES) as Preferences,
      registryPath: null,
      connect: imap.connect,
      fileConfig: false,
    });
    const server = createMcpServer(context, { remote: true });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      ctx.waitUntil(imap.end().finally(() => server.close()));
    }
  },
};

function failureKey(): string {
  return `owner-failures:${Math.floor(Date.now() / 1000 / FAILURE_WINDOW_S)}`;
}

async function failures(env: Env): Promise<number> {
  return Number((await env.OAUTH_KV.get(failureKey())) ?? 0);
}

async function recordFailure(env: Env): Promise<void> {
  const count = (await failures(env)) + 1;
  await env.OAUTH_KV.put(failureKey(), String(count), { expirationTtl: FAILURE_WINDOW_S * 2 });
}

async function passwordMatches(supplied: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [supplied, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value)))
  );
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function withPageHeaders(headers: Headers, extra: string[]): Headers {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActionSources(extra)}; frame-ancestors 'none'`
  );
  return headers;
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const ownerPassword = env.ICLOUD_MAIL_OWNER_PASSWORD ?? "";
  if (ownerPassword.length < 16) {
    return messagePage("ICLOUD_MAIL_OWNER_PASSWORD must be set to at least 16 characters.", 500);
  }
  const extra = parseRedirectList(env.ICLOUD_MAIL_OAUTH_REDIRECT_URIS);
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!isAllowedRedirect(authRequest.redirectUri, extra)) {
        return messagePage("This app's sign-in callback is not allowed for this server.", 403);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return new Response(consentPage(details, consent.handle), {
        headers: withPageHeaders(consent.headers, extra),
      });
    }
    if (request.method !== "POST") return messagePage("Method not allowed.", 405);
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if ((await failures(env)) >= MAX_FAILURES) {
      return messagePage("Too many failed attempts. Try again in an hour.", 429);
    }
    if (!(await passwordMatches(String(form.get("password") ?? ""), ownerPassword))) {
      await recordFailure(env);
      return new Response(retryPage(handle, "Incorrect owner password."), {
        status: 401,
        headers: withPageHeaders(new Headers(), extra),
      });
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [MAIL_SCOPE] });
    if (!isAllowedRedirect(approved.request.redirectUri, extra)) {
      return messagePage("This app's sign-in callback is not allowed for this server.", 403);
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: {},
      scope: [MAIL_SCOPE],
      props: {},
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return messagePage(
        `${error.description}. Return to Claude or ChatGPT and connect again; an approval page is valid for 10 minutes.`
      );
    }
    if (error instanceof CimdFetchError) return messagePage("This app could not be verified.");
    throw error;
  }
}

const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return authorize(request, env);
    if (pathname === "/healthz") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string, extraRedirects: string[]): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: appHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [MAIL_SCOPE],
      requiredScopes: [MAIL_SCOPE],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: "iCloud Mail",
      },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 60 * 60,
      refreshTokenTTL: 30 * 24 * 60 * 60,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const uris = Array.isArray(clientMetadata.redirect_uris)
          ? clientMetadata.redirect_uris
          : [];
        if (
          !uris.some((uri) => typeof uri === "string" && isAllowedRedirect(uri, extraRedirects))
        ) {
          return { description: "No redirect URI is allowed for this server." };
        }
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: WaitUntil): Promise<Response> {
    const origin = new URL(env.ICLOUD_MAIL_PUBLIC_URL || request.url).origin;
    return providerFor(origin, parseRedirectList(env.ICLOUD_MAIL_OAUTH_REDIRECT_URIS)).fetch(
      request as never,
      env,
      ctx as never
    );
  },
};
