import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkMode = process.argv.includes("--check");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const mismatches = [];
update("plugins/icloud-mail/.codex-plugin/plugin.json", (data) => {
  data.version = version;
});
update("plugins/icloud-mail/.claude-plugin/plugin.json", (data) => {
  data.version = version;
});
// wrangler.jsonc has comments, so its version is replaced textually.
{
  const filename = path.join(root, "wrangler.jsonc");
  const original = fs.readFileSync(filename, "utf8");
  const next = original.replace(/("CONNECTOR_VERSION": "\\")[^\\"]*(\\"")/, `$1${version}$2`);
  if (!/"CONNECTOR_VERSION": "\\"/.test(original)) mismatches.push("wrangler.jsonc (define)");
  else if (next !== original) {
    if (checkMode) mismatches.push("wrangler.jsonc");
    else fs.writeFileSync(filename, next);
  }
}
if (checkMode && mismatches.length) {
  console.error(`Plugin versions differ from package.json (${version}): ${mismatches.join(", ")}`);
  process.exitCode = 1;
}
function update(relativePath, change) {
  const filename = path.join(root, relativePath);
  const original = fs.readFileSync(filename, "utf8");
  const data = JSON.parse(original);
  const previous = JSON.stringify(data);
  change(data);
  const next = JSON.stringify(data, null, 2) + "\n";
  if (checkMode) {
    if (JSON.stringify(data) !== previous) mismatches.push(relativePath);
  } else fs.writeFileSync(filename, next);
}
