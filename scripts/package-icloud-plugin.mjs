import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "plugins/icloud-mail");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(target, ".codex-plugin/plugin.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf8"));
assert.equal(manifest.version, version, "Run node scripts/sync-plugin-version.mjs");
assert.equal(catalog.plugins.length, 1, "Only the iCloud connector belongs in this marketplace");
assert.equal(catalog.plugins[0].name, manifest.name);
assert.equal(catalog.plugins[0].version, version);
for (const [file, entries] of [
  [".claude-plugin/plugin.json", (data) => [data]],
  ["../../.claude-plugin/marketplace.json", (data) => data.plugins],
]) {
  const data = JSON.parse(readFileSync(join(target, file), "utf8"));
  for (const entry of entries(data)) {
    assert.equal(entry.name, manifest.name, `${file} must describe ${manifest.name}`);
    assert.equal(entry.version, version, "Run node scripts/sync-plugin-version.mjs");
  }
}
mkdirSync(join(target, "server"), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/icloud/server.ts"],
  outfile: "plugins/icloud-mail/server/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { CONNECTOR_VERSION: JSON.stringify(version) },
  tsconfig: "tsconfig.json",
  metafile: true,
  legalComments: "eof",
});
const sources = Object.keys(result.metafile.inputs)
  .filter((file) => file.startsWith("src/"))
  .sort();
assert(
  !sources.some((file) => /appleMailManager|applescript|jxa|hybridDraft/i.test(file)),
  "The direct connector must not depend on Mail.app automation"
);
const bundle = readFileSync(join(target, "server/server.cjs"));
copyFileSync(join(root, "LICENSE"), join(target, "LICENSE"));
writeFileSync(
  join(target, "server/provenance.json"),
  JSON.stringify(
    {
      connector: manifest.name,
      version,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      runtime: "server.cjs",
      sources,
    },
    null,
    2
  ) + "\n"
);
console.log(`Built ${manifest.name} ${version} from repository source.`);
