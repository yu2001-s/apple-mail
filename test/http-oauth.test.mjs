import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Dependency-free: this file runs against the bundle without node_modules.
const branches = (schema) => (schema.anyOf ? schema.anyOf.flatMap(branches) : [schema]);
const ownerPassword = "correct horse battery staple";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("remote mode requires OAuth and serves the tools to an approved client", async () => {
  const temp = mkdtempSync(join(tmpdir(), "icloud-http-"));
  const sender = "primary@example.com";
  writeFileSync(
    join(temp, "preferences.json"),
    JSON.stringify({ primaryAddress: sender, signatures: {} })
  );
  writeFileSync(join(temp, "config.json"), "{}");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [join(root, "plugins/icloud-mail/server/server.cjs"), "--http"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ICLOUD_MAIL_DATA_DIR: temp,
        APPLE_MAIL_MCP_CONFIG_FILE: join(temp, "config.json"),
        APPLE_MAIL_MCP_IMAP_HOST: "imap.mail.me.com",
        APPLE_MAIL_MCP_IMAP_USER: sender,
        APPLE_MAIL_MCP_IMAP_PASSWORD: "unused",
        APPLE_MAIL_MCP_SMTP_HOST: "smtp.mail.me.com",
        APPLE_MAIL_MCP_SMTP_USER: sender,
        APPLE_MAIL_MCP_SMTP_PASSWORD: "unused",
        ICLOUD_MAIL_PUBLIC_URL: base,
        ICLOUD_MAIL_HTTP_PORT: String(port),
        ICLOUD_MAIL_OWNER_PASSWORD: ownerPassword,
        ICLOUD_MAIL_OAUTH_REDIRECT_URIS: "https://www.app.example/cb,https://app.example/cb",
      },
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 10000);
      child.stderr.on("data", () => {
        if (stderr.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => reject(new Error(`Server exited: ${stderr}`)));
    });

    const rpc = (token, body) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1" },
      },
    };

    // Unauthenticated calls point clients at the protected-resource metadata.
    const anonymous = await rpc(null, initialize);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate"), /resource_metadata=/);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resource.resource, `${base}/mcp`);
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.ok(metadata.registration_endpoint);

    // Registration only accepts known or loopback callbacks.
    const register = (uris) =>
      fetch(metadata.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test <client>",
          redirect_uris: uris,
          token_endpoint_auth_method: "none",
        }),
      });
    assert.equal((await register(["https://evil.example/callback"])).status, 400);
    const client = await (await register([redirectUri])).json();
    assert.ok(client.client_id);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${base}/mcp`,
    }))
      authorizeUrl.searchParams.set(key, value);
    const page = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    // Browsers apply form-action to every redirect after approval, so a configured
    // callback that redirects to another configured host must not be blocked.
    assert.match(
      page.headers.get("content-security-policy"),
      /form-action [^;]*https:\/\/app\.example/
    );
    const html = await page.text();
    assert.match(html, /Test &lt;client&gt;/);
    const requestId = html.match(/name="request_id" value="([^"]+)"/)[1];

    const approve = (password) =>
      fetch(`${base}/oauth/approve`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request_id: requestId, password, decision: "approve" }),
      });
    assert.equal((await approve("wrong password, long enough")).status, 401);
    const approved = await approve(ownerPassword);
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get("location"));
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
    assert.equal(callback.searchParams.get("state"), "xyz");
    const code = callback.searchParams.get("code");

    const token = (params) =>
      fetch(metadata.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client.client_id, ...params }),
      });
    assert.equal(
      (
        await token({
          grant_type: "authorization_code",
          code,
          code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
          redirect_uri: redirectUri,
        })
      ).status,
      400
    );
    // The failed PKCE attempt does not consume the code; a correct one does.
    const tokens = await (
      await token({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: `${base}/mcp`,
      })
    ).json();
    assert.ok(tokens.access_token && tokens.refresh_token, JSON.stringify(tokens));
    const replay = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    assert.equal(replay.status, 400);

    const initialized = await rpc(tokens.access_token, initialize);
    assert.equal(initialized.status, 200, await initialized.clone().text());
    assert.equal((await initialized.json()).result.serverInfo.name, "icloud-mail");
    const listed = await (
      await rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    assert.equal(listed.result.tools.length, 21);
    const createDraft = listed.result.tools.find((tool) => tool.name === "create_draft");
    // Remote callers cannot name files on the server.
    const list = branches(createDraft.inputSchema.properties.attachments).find(
      (schema) => schema.type === "array"
    );
    assert.deepEqual(
      branches(list.items).map((schema) => schema.type),
      ["object"]
    );

    const refreshed = await (
      await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })
    ).json();
    assert.ok(refreshed.access_token);
    const reused = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    assert.equal(reused.status, 400);

    const store = readFileSync(join(temp, "oauth.json"), "utf8");
    assert.ok(!store.includes(tokens.access_token) && !store.includes(refreshed.refresh_token));
    assert.equal(statSync(join(temp, "oauth.json")).mode & 0o777, 0o600);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    rmSync(temp, { recursive: true, force: true });
  }
});
