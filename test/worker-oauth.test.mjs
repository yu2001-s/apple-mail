// Runs the Worker in local workerd (wrangler dev) with synthetic settings and
// walks the OAuth flow a claude.ai connector performs. No iCloud access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerPassword = "correct horse battery staple";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const sender = "primary@example.com";

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

test("worker requires OAuth, gates approval on the owner password, and serves the tools", async () => {
  const state = mkdtempSync(join(tmpdir(), "icloud-worker-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const vars = {
    ICLOUD_MAIL_OWNER_PASSWORD: ownerPassword,
    ICLOUD_MAIL_PREFERENCES: JSON.stringify({ primaryAddress: sender, signatures: {} }),
    APPLE_MAIL_MCP_IMAP_USER: sender,
    APPLE_MAIL_MCP_IMAP_PASSWORD: "unused",
    APPLE_MAIL_MCP_SMTP_USER: sender,
    APPLE_MAIL_MCP_SMTP_PASSWORD: "unused",
    APPLE_MAIL_MCP_SMTP_FROM: sender,
  };
  const child = spawn(
    join(root, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--show-interactive-dev-session=false",
      ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } }
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`wrangler dev did not start:\n${output}`)),
        60000
      );
      const check = setInterval(() => {
        if (output.includes("Ready on")) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 200);
      child.once("exit", () => reject(new Error(`wrangler dev exited:\n${output}`)));
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
        clientInfo: { name: "worker-test", version: "1" },
      },
    };

    const anonymous = await rpc(null, initialize);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate"), /resource_metadata=/);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resource.resource, `${base}/mcp`);
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.client_id_metadata_document_supported, true);

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
    const chatgpt = await register(["https://chatgpt.com/connector/oauth/abc_123"]);
    assert.equal(chatgpt.status, 201, await chatgpt.clone().text());
    const client = await (await register([redirectUri])).json();
    assert.ok(client.client_id);

    const verifier = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "mail",
      state: "xyz",
      resource: `${base}/mcp`,
    }))
      authorizeUrl.searchParams.set(key, value);
    const page = await fetch(authorizeUrl, { redirect: "manual" });
    const html = await page.text();
    assert.equal(page.status, 200, html);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(html, /Test &#60;client&#62;/);
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = page.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");

    const approve = (password, decision = "approve") =>
      fetch(authorizeUrl.origin + authorizeUrl.pathname, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        body: new URLSearchParams({ handle, password, decision }),
      });
    const wrong = await approve("wrong password, long enough");
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Incorrect owner password/);
    const approved = await approve(ownerPassword);
    assert.equal(approved.status, 302, await approved.clone().text());
    const callback = new URL(approved.headers.get("location"));
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
    assert.equal(callback.searchParams.get("state"), "xyz");
    // The handle is single use.
    assert.notEqual((await approve(ownerPassword)).status, 302);

    const tokens = await (
      await fetch(metadata.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: callback.searchParams.get("code"),
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: `${base}/mcp`,
        }),
      })
    ).json();
    assert.ok(tokens.access_token && tokens.refresh_token, JSON.stringify(tokens));

    const initialized = await rpc(tokens.access_token, initialize);
    assert.equal(initialized.status, 200, await initialized.clone().text());
    assert.equal((await initialized.json()).result.serverInfo.name, "icloud-mail");
    const listed = await (
      await rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    assert.equal(listed.result.tools.length, 18);
    const createDraft = listed.result.tools.find((tool) => tool.name === "create_draft");
    assert.equal(createDraft.inputSchema.properties.attachments.items.type, "object");
    const signature = await (
      await rpc(tokens.access_token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_signature", arguments: {} },
      })
    ).json();
    assert.equal(JSON.parse(signature.result.content[0].text).from, sender);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    rmSync(state, { recursive: true, force: true });
  }
});
