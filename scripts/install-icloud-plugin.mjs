import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "plugins/icloud-mail");
const target = join(homedir(), ".codex/plugins/icloud-mail");
const catalogPath = join(homedir(), ".agents/plugins/marketplace.json");
const manifest = JSON.parse(readFileSync(join(source, ".codex-plugin/plugin.json"), "utf8"));
assert(existsSync(join(source, "server/server.cjs")), "Package the connector before installing");
const provenance = JSON.parse(readFileSync(join(source, "server/provenance.json"), "utf8"));
assert.equal(provenance.version, manifest.version, "Bundle and plugin versions must match");
assert.equal(
  createHash("sha256")
    .update(readFileSync(join(source, "server/server.cjs")))
    .digest("hex"),
  provenance.sha256,
  "Bundle integrity check failed"
);
if (existsSync(target)) {
  const current = JSON.parse(readFileSync(join(target, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(current.name, manifest.name, "Refusing to replace another plugin's source");
}
const catalog = existsSync(catalogPath)
  ? JSON.parse(readFileSync(catalogPath, "utf8"))
  : { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
assert(Array.isArray(catalog.plugins), "Personal marketplace must have a plugins array");
const entry = {
  name: manifest.name,
  version: manifest.version,
  source: { source: "local", path: "./.codex/plugins/icloud-mail" },
  policy: { installation: "AVAILABLE", authentication: "ON_USE" },
  category: "Productivity",
};
const index = catalog.plugins.findIndex((plugin) => plugin.name === manifest.name);
if (index < 0) catalog.plugins.push(entry);
else catalog.plugins[index] = { ...catalog.plugins[index], ...entry };
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
mkdirSync(dirname(catalogPath), { recursive: true });
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
const result = spawnSync("codex", ["plugin", "add", `${manifest.name}@${catalog.name}`], {
  stdio: "inherit",
});
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  "Codex plugin installation failed; personal marketplace entry was preserved"
);
console.log(`Personal plugin source: ${target}`);
