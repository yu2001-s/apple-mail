import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("installed bundle boots without node_modules and exposes the direct iCloud tools", async () => {
  const temp = mkdtempSync(join(tmpdir(), "icloud-standalone-"));
  const plugin = join(temp, "plugin");
  cpSync(join(root, "plugins/icloud-mail"), plugin, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(plugin, ".codex-plugin/plugin.json"), "utf8"));
  const provenance = JSON.parse(readFileSync(join(plugin, "server/provenance.json"), "utf8"));
  assert.equal(provenance.version, manifest.version);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(plugin, "server/server.cjs")))
      .digest("hex"),
    provenance.sha256
  );
  const sender = "primary@example.com";
  const signature = "Example Sender\nExample Company";
  writeFileSync(
    join(temp, "preferences.json"),
    JSON.stringify({ primaryAddress: sender, signatures: { [sender]: signature } })
  );
  writeFileSync(join(temp, "config.json"), "{}");
  const claudeManifest = JSON.parse(
    readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8")
  );
  assert.equal(claudeManifest.version, manifest.version);
  const launch = claudeManifest.mcpServers["icloud-mail"];
  assert.deepEqual(launch.args, ["${CLAUDE_PLUGIN_ROOT}/server/launch.sh"]);
  // Start through the same launcher Claude Code and Codex use.
  const args = launch.args.map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", plugin));
  const child = spawn(launch.command, args, {
    cwd: temp,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ICLOUD_MAIL_NODE: process.execPath,
      ICLOUD_MAIL_DATA_DIR: temp,
      ICLOUD_MAIL_ADDRESS_DISCOVERY: "off",
      APPLE_MAIL_MCP_CONFIG_FILE: join(temp, "config.json"),
      APPLE_MAIL_MCP_IMAP_HOST: "imap.mail.me.com",
      APPLE_MAIL_MCP_IMAP_ACCOUNT: sender,
      APPLE_MAIL_MCP_IMAP_USER: sender,
      APPLE_MAIL_MCP_SMTP_HOST: "smtp.mail.me.com",
      APPLE_MAIL_MCP_SMTP_USER: sender,
      APPLE_MAIL_MCP_SMTP_FROM: sender,
      APPLE_MAIL_MCP_SMTP_ALLOWED_FROM: `${sender},alias@example.com`,
    },
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  async function request(id, method, params = {}) {
    const response = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    let timer;
    try {
      const message = await Promise.race([
        response,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP timed out: ${stderr}`)), 10000);
        }),
      ]);
      assert(!message.error, JSON.stringify(message.error));
      return message.result;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "standalone-verification", version: "1" },
    });
    assert.equal(initialized.serverInfo.version, manifest.version);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );
    const { tools } = await request(2, "tools/list");
    assert.equal(tools.length, 20);
    // Strict host validators may not resolve $ref; every field is inlined.
    assert(!JSON.stringify(tools).includes('"$ref"'), "tool schemas must not contain $ref");
    assert(tools.some((tool) => tool.name === "preview_reply" && tool.annotations.readOnlyHint));
    assert(
      tools
        .find((tool) => tool.name === "send_draft")
        .inputSchema.required.includes("expectedRevision")
    );
    const result = await request(3, "tools/call", { name: "get_signature", arguments: {} });
    assert(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).signature, signature);
    // Strict-mode clients (ChatGPT) send null for unset optional arguments.
    const nulled = await request(4, "tools/call", {
      name: "get_signature",
      arguments: { from: null },
    });
    assert(!nulled.isError, JSON.stringify(nulled));
    assert.equal(JSON.parse(nulled.content[0].text).from, sender);
    // ChatGPT requires full matches and rejects escaped punctuation such as `\:`.
    const patterns = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (typeof node.pattern === "string") patterns.push(node.pattern);
      for (const value of Object.values(node)) walk(value);
    };
    for (const tool of tools) walk(tool.inputSchema);
    const samples = [
      ["^[/].*$", "/tmp/attachment.pdf"],
      ["^apple-draft:[A-Za-z0-9_-]+$", "apple-draft:ea1baad1-3355-4665-a658-73e2a389cc6d"],
      ["^imap:[A-Za-z0-9_-]+$", "imap:eyJhIjoiaUNsb3VkIn0"],
    ];
    assert.deepEqual(
      [...new Set(patterns)].sort(),
      samples.map(([pattern]) => pattern)
    );
    for (const [pattern, sample] of samples) {
      assert.equal(new RegExp(pattern, "u").exec(sample)?.[0], sample);
    }
    // Settings edited from chat persist and take effect without a restart.
    const call = async (id, name, args) => {
      const out = await request(id, "tools/call", { name, arguments: args });
      const text = out.content[0].text;
      return { isError: out.isError, data: out.isError ? text : JSON.parse(text) };
    };
    assert.equal(
      (await call(5, "update_settings", { primaryAddress: "alias@example.com" })).data
        .primaryAddress,
      "alias@example.com"
    );
    const signed = await call(6, "set_signature", { signature: "Alias\nExample" });
    assert.deepEqual(signed.data, {
      success: true,
      from: "alias@example.com",
      signature: "Alias\nExample",
    });
    const listed = await call(7, "list_sending_addresses", {});
    assert.equal(listed.data.primaryAddress, "alias@example.com");
    assert.deepEqual(listed.data.withSignature, [sender, "alias@example.com"]);
    const rejected = await call(8, "get_signature", { from: "stranger@example.com" });
    assert(rejected.isError);
    const removed = await call(9, "update_settings", { removeAddresses: ["alias@example.com"] });
    assert(removed.isError, "the primary address cannot be removed");
    const stored = JSON.parse(readFileSync(join(temp, "settings.json"), "utf8"));
    assert.equal(stored.primaryAddress, "alias@example.com");
    const read = tools.find((tool) => tool.name === "read_message").inputSchema;
    assert.deepEqual(read.required, ["id"]);
    assert.equal(read.properties.maxBodyChars.type, "integer");
    assert.equal(read.properties.maxBodyChars.default, 30000);
  } finally {
    lines.close();
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    rmSync(temp, { recursive: true, force: true });
  }
});
