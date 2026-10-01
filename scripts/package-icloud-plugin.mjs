import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(process.argv[2] ?? join(homedir(), ".codex/integrations/icloud-mail"));
const target = join(root, "plugins/icloud-mail");
const manifest = JSON.parse(readFileSync(join(target, ".codex-plugin/plugin.json"), "utf8"));
const bundle = readFileSync(join(source, "server.cjs"));
const text = bundle.toString("utf8");
const version = text.match(/name: "icloud-mail", version: "([^"]+)"/)?.[1];
assert.equal(version, manifest.version, "Bundle and plugin versions must match");
assert(!/from ["']@existing|require\(["']@existing/.test(text), "Runtime must be bundled");
const marketplace = JSON.parse(readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf8"));
assert.equal(marketplace.plugins.find(p => p.name === manifest.name)?.version, manifest.version,
  "Marketplace and plugin versions must match");
mkdirSync(join(target, "server"), { recursive: true });
writeFileSync(join(target, "server/server.cjs"), bundle);
copyFileSync(join(source, "UPSTREAM-LICENSE"), join(target, "LICENSE"));
writeFileSync(join(target, "server/provenance.json"), JSON.stringify({
  connector: "icloud-mail",
  version,
  sha256: createHash("sha256").update(bundle).digest("hex"),
  runtime: "server.cjs",
  packaging: "Unmodified standalone bundle; dependencies included; persistent data excluded",
}, null, 2) + "\n");
console.log(`Packaged ${manifest.name} ${version} at ${target}`);
