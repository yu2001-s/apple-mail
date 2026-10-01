import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(process.argv[2] ?? join(root, "plugins/icloud-mail"));
const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
const config = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers[
  "icloud-mail"
];
const provenance = JSON.parse(readFileSync(join(pluginRoot, "server/provenance.json"), "utf8"));
const bundle = readFileSync(join(pluginRoot, "server/server.cjs"));
assert.equal(createHash("sha256").update(bundle).digest("hex"), provenance.sha256);
assert.equal(provenance.version, manifest.version);
assert(
  !Object.keys(config.env ?? {}).some((key) => /pass|secret|token/i.test(key)),
  "Plugin must not embed credentials"
);

// Emulate Codex's plugin-relative path resolution from an unrelated task cwd.
process.chdir(tmpdir());
const transport = new StdioClientTransport({
  command: config.command,
  args: config.args.map((arg) => (arg.startsWith("./") ? resolve(pluginRoot, arg) : arg)),
  cwd: resolve(pluginRoot, config.cwd ?? "."),
  stderr: "pipe",
});
const client = new Client({ name: "icloud-plugin-verification", version: "1.0.0" });
const tests = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
  assert(!result.isError, `${name}: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, manifest.version);
  const { tools } = await client.listTools();
  for (const name of [
    "health_check",
    "search_messages",
    "read_message",
    "get_signature",
    "preview_reply",
    "create_reply_draft",
    "update_draft",
    "send_draft",
  ]) {
    assert(
      tools.some((tool) => tool.name === name),
      `Missing tool: ${name}`
    );
  }
  const reply = tools.find((tool) => tool.name === "preview_reply");
  assert.equal(reply.annotations.readOnlyHint, true);
  assert.equal(reply.inputSchema.properties.replyAll.default, false);
  assert(
    tools
      .find((tool) => tool.name === "send_draft")
      .inputSchema.required.includes("expectedRevision")
  );
  tests.push("Bundle integrity, MCP handshake, tool discovery, reply defaults, and revision gate");

  const health = await call("health_check");
  assert(health.imap && health.smtp && health.usesMailApp === false);
  tests.push("IMAP and SMTP authentication without sending");
  const senders = await call("list_sending_addresses");
  assert(senders.addresses.includes(senders.primaryAddress));
  const signature = await call("get_signature");
  assert.equal(signature.from, senders.primaryAddress);
  tests.push("Configured sender aliases and saved signature");
  const boxes = await call("list_mailboxes");
  assert(boxes.mailboxes.some((box) => box.path === "INBOX"));
  const inbox = await call("search_messages", {
    mailbox: "INBOX",
    to: senders.primaryAddress,
    limit: 1,
  });
  assert(Array.isArray(inbox.messages));
  assert(inbox.messages.length, "A source message is needed for the live reply preview");
  tests.push("Server mailbox listing and primary-address inbox search");
  const originalMessageId = inbox.messages[0].id;
  const message = await call("read_message", { id: originalMessageId, maxBodyChars: 1000 });
  assert(message.success && message.message);
  const attachments = await call("list_attachments", { id: originalMessageId });
  assert(attachments.success);
  tests.push("Read-only message read and attachment metadata");
  const body = "Plugin migration verification; preview only.";
  const preview = await call("preview_reply", { originalMessageId, body });
  assert(preview.success && preview.reply);
  assert.equal(preview.reply.from, senders.primaryAddress);
  assert(preview.reply.to.length > 0);
  assert.equal(preview.reply.bcc, undefined);
  assert.match(preview.reply.inReplyTo, /^<[^<>\s]+@[^<>\s]+>$/);
  assert(preview.reply.references.includes(preview.reply.inReplyTo));
  assert.equal(
    preview.reply.body,
    signature.signature ? `${body}\n\n${signature.signature}` : body
  );
  const unsigned = await call("preview_reply", {
    originalMessageId,
    body,
    includeSignature: false,
  });
  assert.equal(unsigned.reply.body, body);
  tests.push("Threaded reply preview, exact saved signature, and signature opt-out");
  console.log(
    JSON.stringify(
      {
        success: true,
        pluginRoot,
        version: manifest.version,
        tools: tools.length,
        tests,
        sentMessages: 0,
        createdDrafts: 0,
      },
      null,
      2
    )
  );
} finally {
  await client.close();
}
