// Copy package.json's version into wrangler.jsonc's CONNECTOR_VERSION define.
// `--check` reports a mismatch instead of writing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
// wrangler.jsonc has comments, so the version is replaced textually.
const filename = path.join(root, "wrangler.jsonc");
const original = fs.readFileSync(filename, "utf8");
if (!/"CONNECTOR_VERSION": "\\"/.test(original)) {
  console.error("wrangler.jsonc has no CONNECTOR_VERSION define.");
  process.exit(1);
}
const next = original.replace(/("CONNECTOR_VERSION": "\\")[^\\"]*(\\"")/, `$1${version}$2`);
if (process.argv.includes("--check")) {
  if (next !== original) {
    console.error(`wrangler.jsonc's CONNECTOR_VERSION differs from package.json (${version}).`);
    process.exitCode = 1;
  }
} else if (next !== original) {
  fs.writeFileSync(filename, next);
}
