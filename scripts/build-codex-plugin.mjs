import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const target = path.join(root, "codex");
const server = path.join(target, "server");

fs.mkdirSync(server, { recursive: true });
fs.copyFileSync(path.join(root, "build", "index.js"), path.join(server, "index.js"));
fs.copyFileSync(
  path.join(root, "build", "schedulerCli.js"),
  path.join(server, "schedulerCli.js")
);
fs.writeFileSync(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "apple-mail-codex-plugin",
      version: packageJson.version,
      private: true,
      type: "module",
    },
    null,
    2
  )}\n`,
  { mode: 0o644 }
);
