/**
 * /accounts: where the owner links and removes Google accounts.
 *
 * The owner password opens a short session (an HttpOnly cookie naming a KV
 * record that also holds the form CSRF token). Linking runs Google's OAuth
 * code flow with PKCE; the callback only completes for the browser session
 * that started it, so nobody can slip their own account into the connector.
 */
import { GoogleAccounts, kvGoogleAccountStore } from "../google/accounts.js";
import { importSecretKey } from "../google/crypto.js";
import {
  exchangeCode,
  googleAuthUrl,
  pkcePair,
  type Fetch,
  type GoogleClientConfig,
} from "../google/oauth.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { page } from "./consent.js";
import type { Env } from "./index.js";
import {
  failures,
  MAX_FAILURES,
  passwordMatches,
  recordFailure,
  withPageHeaders,
} from "./owner.js";

const SESSION_COOKIE = "accounts_session";
const SESSION_TTL_S = 30 * 60;
const LINK_TTL_S = 10 * 60;
const TITLE = "Connected accounts";
const FORM_ACTION = "'self' https://accounts.google.com";

/** Why Google accounts cannot be used yet, or undefined when they can. */
export function googleSetupProblem(env: Env): string | undefined {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return "Google is not set up: set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets (see docs/GOOGLE.md).";
  }
  if ((env.CONNECTOR_SECRET_KEY ?? "").length < 32) {
    return "Set the CONNECTOR_SECRET_KEY secret (at least 32 random characters) to store Google tokens.";
  }
  return undefined;
}

function googleConfig(env: Env): GoogleClientConfig {
  return { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! };
}

/** Linked Google accounts backed by the Worker's KV, or undefined when Google is not set up. */
export function googleAccountsFor(env: Env, origin?: string, fetchImpl?: Fetch) {
  if (googleSetupProblem(env)) return undefined;
  return new GoogleAccounts({
    config: googleConfig(env),
    store: kvGoogleAccountStore(env.OAUTH_KV),
    key: importSecretKey(env.CONNECTOR_SECRET_KEY!),
    manageUrl: origin ? `${origin}/accounts` : undefined,
    fetch: fetchImpl,
  });
}

function html(body: string, status = 200, headers = new Headers()): Response {
  return new Response(page(TITLE, body), {
    status,
    headers: withPageHeaders(headers, FORM_ACTION),
  });
}

function redirect(location: string, headers = new Headers()): Response {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 303, headers });
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

interface Session {
  id: string;
  csrf: string;
}

async function session(request: Request, env: Env): Promise<Session | undefined> {
  const id = cookie(request, SESSION_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{32}$/.test(id)) return undefined;
  const raw = await env.OAUTH_KV.get(`accounts-session:${id}`);
  return raw ? { id, ...(JSON.parse(raw) as { csrf: string }) } : undefined;
}

function sessionCookie(id: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/accounts; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function loginPage(error?: string, status = 200): Response {
  return html(
    `<h1>${TITLE}</h1>
<p>Link Gmail and Google Calendar accounts to this connector.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="action" value="login">
<label>Owner password<input type="password" name="password" autocomplete="current-password" autofocus></label>
<button>Continue</button>
</form>`,
    status
  );
}

async function listPage(
  google: GoogleAccounts,
  current: Session,
  notice?: { ok: boolean; text: string }
): Promise<Response> {
  const accounts = await google.summaries();
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(current.csrf)}">`;
  const rows = accounts
    .map(
      (account) => `<li><span><strong>${escapeHtml(account.email)}</strong><br><span class="note">${
        account.services.length ? escapeHtml(account.services.join(", ")) : "no access granted"
      }</span></span>
<form method="post">${hidden}<input type="hidden" name="action" value="remove"><input type="hidden" name="email" value="${escapeHtml(account.email)}"><button>Remove</button></form></li>`
    )
    .join("\n");
  return html(`<h1>${TITLE}</h1>
${notice ? `<p class="${notice.ok ? "ok" : "error"}">${escapeHtml(notice.text)}</p>` : ""}
<h2>Google</h2>
${accounts.length ? `<ul class="accounts">${rows}</ul>` : "<p>No Google account is linked yet.</p>"}
<form method="post">${hidden}<input type="hidden" name="action" value="link"><button>Link a Google account</button></form>
<p class="note">Allow both Gmail and Calendar on Google's consent screen. Google may warn that the app is unverified: it is your own OAuth client, so choose Advanced, then continue. Changes reach Claude and ChatGPT within a minute.</p>
<form method="post">${hidden}<input type="hidden" name="action" value="logout"><button>Sign out</button></form>`);
}

export async function handleAccounts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = new URL(env.ICLOUD_MAIL_PUBLIC_URL || request.url).origin;
  const ownerPassword = env.ICLOUD_MAIL_OWNER_PASSWORD ?? "";
  if (ownerPassword.length < 16) {
    return html("<p>ICLOUD_MAIL_OWNER_PASSWORD must be set to at least 16 characters.</p>", 500);
  }
  const problem = googleSetupProblem(env);
  if (problem) return html(`<h1>${TITLE}</h1><p>${escapeHtml(problem)}</p>`, 503);
  const google = googleAccountsFor(env, origin)!;
  const callbackUrl = `${origin}/accounts/google/callback`;

  if (url.pathname === "/accounts/google/callback") {
    if (request.method !== "GET") return html("<p>Method not allowed.</p>", 405);
    const state = url.searchParams.get("state") ?? "";
    const key = `google-link:${state}`;
    const pending = /^[A-Za-z0-9_-]{32}$/.test(state) ? await env.OAUTH_KV.get(key) : null;
    if (!pending) {
      return html(
        `<p>This sign-in has expired or was already used. <a href="/accounts">Start again</a>.</p>`,
        400
      );
    }
    await env.OAUTH_KV.delete(key);
    const link = JSON.parse(pending) as { session: string; verifier: string };
    const current = await session(request, env);
    if (!current || current.id !== link.session) {
      return html(
        `<p>Finish linking in the browser that started it. <a href="/accounts">Start again</a>.</p>`,
        403
      );
    }
    const error = url.searchParams.get("error");
    if (error) {
      return listPage(google, current, {
        ok: false,
        text: error === "access_denied" ? "Google access was not granted." : `Google: ${error}`,
      });
    }
    try {
      const tokens = await exchangeCode(googleConfig(env), {
        code: url.searchParams.get("code") ?? "",
        redirectUri: callbackUrl,
        codeVerifier: link.verifier,
      });
      await google.link(tokens);
      const [summary] = (await google.summaries()).filter((item) => item.email === tokens.email);
      const missing = (["gmail", "calendar"] as const).filter(
        (service) => !summary?.services.includes(service)
      );
      return listPage(google, current, {
        ok: missing.length === 0,
        text: missing.length
          ? `Linked ${tokens.email}, but without ${missing.join(" or ")} access. Link it again and allow everything to use those tools.`
          : `Linked ${tokens.email}.`,
      });
    } catch (e) {
      return listPage(google, current, {
        ok: false,
        text: e instanceof Error ? e.message : "Linking failed.",
      });
    }
  }

  if (url.pathname !== "/accounts") return html("<p>Not found.</p>", 404);
  if (request.method === "GET") {
    const current = await session(request, env);
    return current ? listPage(google, current) : loginPage();
  }
  if (request.method !== "POST") return html("<p>Method not allowed.</p>", 405);
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  if (action === "login") {
    if ((await failures(env.OAUTH_KV)) >= MAX_FAILURES) {
      return loginPage("Too many failed attempts. Try again in an hour.", 429);
    }
    if (!(await passwordMatches(String(form.get("password") ?? ""), ownerPassword))) {
      await recordFailure(env.OAUTH_KV);
      return loginPage("Incorrect owner password.", 401);
    }
    const id = randomToken();
    await env.OAUTH_KV.put(`accounts-session:${id}`, JSON.stringify({ csrf: randomToken() }), {
      expirationTtl: SESSION_TTL_S,
    });
    return redirect("/accounts", new Headers({ "Set-Cookie": sessionCookie(id, SESSION_TTL_S) }));
  }

  const current = await session(request, env);
  if (!current) return loginPage("Your session expired; enter the owner password again.", 401);
  if (!(await passwordMatches(String(form.get("csrf") ?? ""), current.csrf))) {
    return html('<p>This form is out of date. <a href="/accounts">Reload</a>.</p>', 403);
  }
  if (action === "link") {
    const state = randomToken();
    const { verifier, challenge } = await pkcePair();
    await env.OAUTH_KV.put(
      `google-link:${state}`,
      JSON.stringify({ session: current.id, verifier }),
      { expirationTtl: LINK_TTL_S }
    );
    return redirect(
      googleAuthUrl(googleConfig(env), {
        redirectUri: callbackUrl,
        state,
        codeChallenge: challenge,
      })
    );
  }
  if (action === "remove") {
    const email = String(form.get("email") ?? "");
    const removed = await google.unlink(email);
    return listPage(google, current, {
      ok: removed,
      text: removed ? `Removed ${email} and revoked its access.` : `${email} is not linked.`,
    });
  }
  if (action === "logout") {
    await env.OAUTH_KV.delete(`accounts-session:${current.id}`);
    return redirect("/accounts", new Headers({ "Set-Cookie": sessionCookie("", 0) }));
  }
  return html("<p>Unknown action.</p>", 400);
}
