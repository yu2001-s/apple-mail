import { describe, expect, it } from "vitest";
import {
  batchBody,
  GoogleAccounts,
  kvGoogleAccountStore,
  parseBatchResponse,
  type StoredGoogleAccount,
} from "./accounts.js";
import { importSecretKey, open, seal } from "./crypto.js";
import {
  CALENDAR_SCOPE,
  exchangeCode,
  GMAIL_SCOPE,
  googleAuthUrl,
  GOOGLE_SCOPES,
} from "./oauth.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const config = { clientId: "client.apps.googleusercontent.com", clientSecret: "shh" };

function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
  };
}

function idToken(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

/** fetch that answers Google's token, revoke and API endpoints. */
function googleFetch(handlers: Record<string, (init: RequestInit) => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(handlers).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return handlers[key](init);
  }) as typeof fetch;
  return { impl, calls };
}

async function linked(
  scopes = [GMAIL_SCOPE, CALENDAR_SCOPE],
  fetchImpl?: typeof fetch,
  email = "a@gmail.com"
) {
  const kv = memoryKv();
  const accounts = new GoogleAccounts({
    config,
    store: kvGoogleAccountStore(kv),
    key: importSecretKey(SECRET),
    manageUrl: "https://w.example/accounts",
    fetch: fetchImpl,
  });
  await accounts.link({
    email,
    sub: "1",
    refreshToken: "refresh-1",
    accessToken: "access-0",
    expiresIn: 3600,
    scopes,
  });
  return { accounts, kv };
}

describe("crypto", () => {
  it("round-trips, and binds the ciphertext to its account", async () => {
    const key = await importSecretKey(SECRET);
    const sealed = await seal(key, "refresh-token", "a@gmail.com");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("refresh-token");
    expect(await open(key, sealed, "a@gmail.com")).toBe("refresh-token");
    await expect(open(key, sealed, "b@gmail.com")).rejects.toThrow(/cannot be decrypted/);
    await expect(
      open(await importSecretKey(`${SECRET}x`), sealed, "a@gmail.com")
    ).rejects.toThrow();
    await expect(importSecretKey("short")).rejects.toThrow(/32 characters/);
  });
});

describe("oauth", () => {
  it("asks for offline Gmail and Calendar access with PKCE", () => {
    const url = new URL(
      googleAuthUrl(config, { redirectUri: "https://w.example/cb", state: "s", codeChallenge: "c" })
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("checks the ID token's audience and issuer", async () => {
    const answer = (claims: Record<string, unknown>) =>
      googleFetch({
        "https://oauth2.googleapis.com/token": () =>
          Response.json({
            access_token: "at",
            refresh_token: "rt",
            expires_in: 3599,
            scope: `openid ${GMAIL_SCOPE}`,
            id_token: idToken(claims),
          }),
      }).impl;
    const good = {
      aud: config.clientId,
      iss: "https://accounts.google.com",
      email: "A@Gmail.com",
      email_verified: true,
      sub: "9",
    };
    const tokens = await exchangeCode(
      config,
      { code: "c", redirectUri: "r", codeVerifier: "v" },
      answer(good)
    );
    expect(tokens).toMatchObject({
      email: "a@gmail.com",
      sub: "9",
      refreshToken: "rt",
      scopes: ["openid", GMAIL_SCOPE],
    });
    await expect(
      exchangeCode(
        config,
        { code: "c", redirectUri: "r", codeVerifier: "v" },
        answer({ ...good, aud: "other" })
      )
    ).rejects.toThrow(/different app/);
  });
});

describe("GoogleAccounts", () => {
  it("stores only sealed refresh tokens", async () => {
    const { kv, accounts } = await linked();
    const stored = kv.data.get("google-accounts:v1")!;
    expect(stored).not.toContain("refresh-1");
    const [account] = JSON.parse(stored).accounts as StoredGoogleAccount[];
    expect(account.email).toBe("a@gmail.com");
    expect(await accounts.summaries()).toEqual([
      { email: "a@gmail.com", services: ["gmail", "calendar"], addedAt: account.addedAt },
    ]);
  });

  it("resolves the account a call addresses", async () => {
    const { accounts } = await linked();
    expect(await accounts.resolve(undefined, "gmail")).toBe("a@gmail.com");
    expect(await accounts.resolve("A@gmail.com", "calendar")).toBe("a@gmail.com");
    await expect(accounts.resolve("x@gmail.com", "gmail")).rejects.toThrow(
      /not a linked Google account/
    );
    await accounts.link({
      email: "b@work.com",
      sub: "2",
      refreshToken: "r2",
      accessToken: "a2",
      expiresIn: 3600,
      scopes: [GMAIL_SCOPE],
    });
    await expect(accounts.resolve(undefined, "gmail")).rejects.toThrow(/a@gmail.com, b@work.com/);
    expect(await accounts.resolveAll(undefined, "gmail")).toEqual(["a@gmail.com", "b@work.com"]);
    expect(await accounts.resolve(undefined, "calendar")).toBe("a@gmail.com");
    await expect(accounts.resolve("b@work.com", "calendar")).rejects.toThrow(
      /did not grant Calendar/
    );
  });

  it("reports when nothing is linked", async () => {
    const accounts = new GoogleAccounts({
      config,
      store: kvGoogleAccountStore(memoryKv()),
      key: importSecretKey(SECRET),
      manageUrl: "https://w.example/accounts",
    });
    await expect(accounts.resolve(undefined, "gmail")).rejects.toThrow(
      /https:\/\/w.example\/accounts/
    );
  });

  it("refreshes an expired or rejected access token once", async () => {
    let issued = 0;
    const { impl, calls } = googleFetch({
      "https://oauth2.googleapis.com/token": (init) => {
        expect(String(init.body)).toContain("refresh_token=refresh-1");
        issued += 1;
        return Response.json({ access_token: `access-${issued}`, expires_in: 3600 });
      },
      "https://gmail.googleapis.com/": (init) => {
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === "Bearer access-0"
          ? new Response("{}", { status: 401 })
          : Response.json({ ok: auth });
      },
    });
    const { accounts } = await linked(undefined, impl);
    expect(await accounts.request("a@gmail.com", "https://gmail.googleapis.com/x")).toEqual({
      ok: "Bearer access-1",
    });
    expect(await accounts.request("a@gmail.com", "https://gmail.googleapis.com/x")).toEqual({
      ok: "Bearer access-1",
    });
    expect(issued).toBe(1);
    expect(calls.filter((call) => call.url.startsWith("https://gmail")).length).toBe(3);
  });

  it("explains how to recover from a revoked grant", async () => {
    const { impl } = googleFetch({
      "https://oauth2.googleapis.com/token": () =>
        Response.json(
          { error: "invalid_grant", error_description: "Token has been expired or revoked." },
          { status: 400 }
        ),
    });
    const { accounts } = await linked(undefined, impl);
    (accounts as any).tokens.clear();
    await expect(accounts.accessToken("a@gmail.com")).rejects.toThrow(
      /no longer accepts .*link it again at https:\/\/w.example\/accounts/
    );
  });

  it("turns Google errors into readable messages", async () => {
    const { impl } = googleFetch({
      "https://gmail.googleapis.com/": () =>
        Response.json(
          { error: { code: 404, message: "Requested entity was not found." } },
          { status: 404 }
        ),
      "https://www.googleapis.com/": () =>
        Response.json(
          { error: { code: 403, message: "Request had insufficient authentication scopes." } },
          { status: 403 }
        ),
    });
    const { accounts } = await linked(undefined, impl);
    await expect(accounts.request("a@gmail.com", "https://gmail.googleapis.com/x")).rejects.toThrow(
      "Google API error 404 for a@gmail.com: Requested entity was not found."
    );
    await expect(accounts.request("a@gmail.com", "https://www.googleapis.com/x")).rejects.toThrow(
      /did not grant/
    );
  });

  it("unlinks and revokes", async () => {
    const { impl, calls } = googleFetch({
      "https://oauth2.googleapis.com/revoke": () => new Response(""),
    });
    const { accounts } = await linked(undefined, impl);
    expect(await accounts.unlink("A@gmail.com")).toBe(true);
    expect(String(calls[0].init.body)).toBe("token=refresh-1");
    expect(await accounts.accounts()).toEqual([]);
    expect(await accounts.unlink("a@gmail.com")).toBe(false);
  });
});

describe("batch", () => {
  it("encodes calls and decodes Google's multipart reply in request order", () => {
    const body = batchBody("B", [
      { method: "GET", path: "/gmail/v1/users/me/threads/a" },
      { method: "POST", path: "/x", body: { y: 1 } },
    ]);
    expect(body).toBe(
      "--B\r\nContent-Type: application/http\r\nContent-ID: <item0>\r\n\r\nGET /gmail/v1/users/me/threads/a\r\n\r\n" +
        '--B\r\nContent-Type: application/http\r\nContent-ID: <item1>\r\n\r\nPOST /x\r\nContent-Type: application/json\r\n\r\n{"y":1}\r\n' +
        "--B--\r\n"
    );
    const reply = [
      "--batch_R",
      "Content-Type: application/http",
      "Content-ID: <response-item1>",
      "",
      "HTTP/1.1 404 Not Found",
      "Content-Type: application/json; charset=UTF-8",
      "",
      '{"error":{"message":"gone"}}',
      "--batch_R",
      "Content-Type: application/http",
      "Content-ID: <response-item0>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json; charset=UTF-8",
      "",
      '{"id":"a"}',
      "--batch_R--",
    ].join("\r\n");
    expect(parseBatchResponse("multipart/mixed; boundary=batch_R", reply, 3)).toEqual([
      { status: 200, body: { id: "a" } },
      { status: 404, body: { error: { message: "gone" } } },
      { status: 500, body: { error: { message: "Missing from Google's batch response." } } },
    ]);
  });
});
