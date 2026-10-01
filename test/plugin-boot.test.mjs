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
  const child = spawn(process.execPath, [join(plugin, "server/server.cjs")], {
    cwd: temp,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ICLOUD_MAIL_DATA_DIR: temp,
      APPLE_MAIL_MCP_CONFIG_FILE: join(temp, "config.json"),
      APPLE_MAIL_MCP_IMAP_HOST: "imap.mail.me.com",
      APPLE_MAIL_MCP_IMAP_ACCOUNT: sender,
      APPLE_MAIL_MCP_IMAP_USER: sender,
      APPLE_MAIL_MCP_SMTP_HOST: "smtp.mail.me.com",
      APPLE_MAIL_MCP_SMTP_USER: sender,
      APPLE_MAIL_MCP_SMTP_FROM: sender,
      APPLE_MAIL_MCP_SMTP_ALLOWED_FROM: sender,
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
    assert.equal(tools.length, 18);
    assert(tools.some((tool) => tool.name === "preview_reply" && tool.annotations.readOnlyHint));
    assert(
      tools
        .find((tool) => tool.name === "send_draft")
        .inputSchema.required.includes("expectedRevision")
    );
    const result = await request(3, "tools/call", { name: "get_signature", arguments: {} });
    assert(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).signature, signature);
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
