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
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

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
    APPLE_MAIL_MCP_SMTP_ALLOWED_FROM: "alias@example.com",
    ICLOUD_MAIL_ADDRESS_DISCOVERY: "off",
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
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_LOG_PATH: join(state, "logs"),
        WRANGLER_REGISTRY_PATH: join(state, "registry"),
      },
    }
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
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /frame-ancestors 'none'/);
    // Browsers apply form-action to the post-submit redirect back to the client.
    assert.match(csp, /form-action [^;]*https:\/\/claude\.ai/);
    // Enter in the password field submits the first button, which must approve.
    assert.ok(html.indexOf('value="approve"') < html.indexOf('value="deny"'));
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
    assert.equal(listed.result.tools.length, 20);
    // A host must accept null before a tools/call can reach the Worker.
    const schemas = new AjvJsonSchemaValidator();
    for (const tool of listed.result.tools) {
      for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
        const required = tool.inputSchema.required?.includes(field) ?? false;
        const result = schemas.getValidator(schema)(null);
        assert.equal(result.valid, !required, `${tool.name}.${field}: null handling`);
      }
    }
    for (const name of ["get_signature", "preview_reply", "set_signature"]) {
      const validate = schemas.getValidator(
        listed.result.tools.find((tool) => tool.name === name).inputSchema.properties.from
      );
      assert(validate("stranger@example.com").valid, `${name}: validate senders at runtime`);
      assert(!validate("invalid").valid, `${name}: from must remain an email field`);
    }
    // Validate like a host that requires the pattern to match the complete ID.
    // A prefix-only pattern passes RegExp.test(), but fails this host check.
    for (const [name, field, sample, invalid] of [
      ["read_message", "id", "imap:eyJhIjoiaUNsb3VkIn0", "imap:"],
      ["preview_reply", "originalMessageId", "imap:eyJhIjoiaUNsb3VkIn0", "imap:!"],
      ["get_draft", "draftId", "apple-draft:ea1baad1-3355-4665-a658-73e2a389cc6d", "apple-draft:"],
    ]) {
      const schema = listed.result.tools.find((tool) => tool.name === name).inputSchema;
      const pattern = new RegExp(schema.properties[field].pattern, "u");
      assert.equal(pattern.exec(sample)?.[0], sample, `${name}: full ID must match`);
      assert.equal(pattern.test(invalid), false, `${name}: invalid ID must be rejected`);
      assert.equal(
        pattern.test(`other:${sample}`),
        false,
        `${name}: wrong prefix must be rejected`
      );
    }
    const createDraft = listed.result.tools.find((tool) => tool.name === "create_draft");
    const validateAttachments = schemas.getValidator(
      createDraft.inputSchema.properties.attachments
    );
    assert(validateAttachments([{ filename: "test.txt", contentBase64: "dGVzdA==" }]).valid);
    assert(!validateAttachments(["/tmp/test.txt"]).valid);
    const signature = await (
      await rpc(tokens.access_token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_signature", arguments: {} },
      })
    ).json();
    assert.equal(JSON.parse(signature.result.content[0].text).from, sender);
    const nulled = await (
      await rpc(tokens.access_token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_signature", arguments: { from: null } },
      })
    ).json();
    assert.ok(!nulled.result.isError, JSON.stringify(nulled));
    assert.equal(JSON.parse(nulled.result.content[0].text).from, sender);
    // Each request builds a fresh context, so this proves settings persist in KV.
    const tool = async (id, name, args) =>
      (
        await (
          await rpc(tokens.access_token, {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          })
        ).json()
      ).result;
    const updated = await tool(5, "update_settings", {
      primaryAddress: "alias@example.com",
      addAddresses: null,
      removeAddresses: null,
    });
    assert.ok(!updated.isError, JSON.stringify(updated));
    const signed = await tool(6, "set_signature", { from: null, signature: "Alias" });
    assert.ok(!signed.isError, JSON.stringify(signed));
    const reread = JSON.parse((await tool(7, "get_signature", {})).content[0].text);
    assert.deepEqual(reread, { success: true, from: "alias@example.com", signature: "Alias" });
    for (const [name, args] of [
      ["get_signature", { from: "stranger@example.com" }],
      ["get_signature", { from: "invalid" }],
      ["set_signature", { from: null, signature: null }],
      ["update_settings", { removeAddresses: ["alias@example.com"] }],
    ]) {
      const rejected = await tool(8, name, args);
      assert.ok(rejected.isError, `${name}: invalid arguments must be rejected`);
    }
    const unchanged = JSON.parse((await tool(9, "get_signature", { from: null })).content[0].text);
    assert.deepEqual(unchanged, reread, "rejected calls must not change settings");
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    rmSync(state, { recursive: true, force: true });
  }
});
