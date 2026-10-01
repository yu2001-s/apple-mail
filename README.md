# iCloud Mail

A direct iCloud IMAP/SMTP connector for Claude and Codex. It searches and reads
mail, creates synchronized drafts, resolves threaded replies, and applies saved
sender signatures. It does not launch Mail.app or use AppleScript.

The bundled runtime and minimal Skill live in `plugins/icloud-mail/`. The same
bundle runs several ways:

| Where | How | Guide |
| --- | --- | --- |
| Claude and ChatGPT on every device | Cloudflare Worker, added once per account | [docs/WORKER.md](docs/WORKER.md) |
| Same, on your own machine | Remote MCP server with OAuth | [docs/REMOTE.md](docs/REMOTE.md) |
| Codex, locally | Personal Codex Plugin | below |
| Claude Code, locally | Plugin directory | below |

The Worker is the recommended setup: a connector added to a Claude or ChatGPT
account works in every app and device signed in to it, with nothing to
install per machine.

## Run locally in Claude Code

For development, load the plugin directory directly:

```sh
claude --plugin-dir plugins/icloud-mail
```

The plugin starts the server through `server/launch.sh`, which finds Node.js
20+ in `PATH` or the usual Homebrew, Volta and nvm locations
(`ICLOUD_MAIL_NODE` selects one explicitly). It needs the account
configuration described in [docs/IMAP-SETUP.md](docs/IMAP-SETUP.md).

## Install in Codex

The checked-in bundle includes its dependencies; installation needs Node.js 20+
without an npm install:

```sh
node scripts/install-icloud-plugin.mjs
```

This installs `icloud-mail@personal`, making it available across projects. The
personal source lives at `~/.codex/plugins/icloud-mail/`; Codex loads the installed
copy under `~/.codex/plugins/cache/personal/icloud-mail/<version>/`.

See [the plugin guide](plugins/icloud-mail/README.md) for configuration and live,
read-only verification. Start a new chat after installing or updating.

## Persistent data

Account configuration remains in
`~/Library/Application Support/apple-mail-mcp/config.json`, with passwords in
macOS Keychain. The primary address, sending addresses and signatures live in
`~/.codex/integrations/icloud-mail/settings.json` (KV on the Worker), seeded
from `preferences.json` and the account configuration on first use and edited
from chat with `update_settings` and `set_signature`. iCloud has no API for
its alias settings, so `list_sending_addresses` adds addresses found in Sent
and suggests custom-domain recipients from the inbox. These are user data,
separate from the plugin package. Keep them across upgrades.

Drafts live on iCloud: each managed draft carries its ID in a header, so every
device and the remote server see the same drafts, revisions and send state. The
adjacent `drafts.json` is a per-device cache that can be rebuilt from the
server.

## Develop

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build:plugin
pnpm test
```

`src/icloud/server.ts` is the MCP entrypoint: it serves the tools from
`tools.ts` over stdio, or over HTTP (`http.ts`, `oauth.ts`) with `--http`.
`src/worker/index.ts` serves the same tools from a Cloudflare Worker. The
shared IMAP, SMTP, MIME, and draft modules remain under `src/`.
`pnpm build:plugin` builds the standalone bundle directly from these sources and
records its SHA-256 and source inputs. It does not read an older installed
connector. After changing source, rebuild and reinstall or update the plugin.

The standalone boot test copies the plugin into a temporary directory with no
`node_modules`, starts it through the plugin launcher with synthetic
preferences, and checks MCP discovery and signature retrieval without contacting
iCloud. The HTTP test runs the full OAuth flow against the bundle, and
`pnpm test:worker` does the same for the Worker in local workerd. For live
validation:

```sh
node scripts/verify-icloud-plugin.mjs
```

This authenticates IMAP/SMTP and checks search, reads, and reply previews. It
neither creates drafts nor sends messages. Real IMAP integration tests can also
run against GreenMail with `RUN_IMAP_IT=1 pnpm test:imap`.

## Attribution

The transport, MIME, and draft modules derive from
[sweetrb/apple-mail-mcp](https://github.com/sweetrb/apple-mail-mcp), under the MIT
license. The original copyright notice is preserved in [LICENSE](LICENSE).
