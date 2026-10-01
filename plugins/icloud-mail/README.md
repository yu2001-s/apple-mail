# iCloud Mail Plugin

A standalone Codex Plugin for iCloud IMAP/SMTP, threaded replies,
revision-checked drafts, and saved sender signatures. The repository contains
its source and bundled dependencies. Mail.app and AppleScript are not required.

## Install and update

From the repository root:

```sh
node scripts/install-icloud-plugin.mjs
```

The installer preserves other personal marketplace entries, copies this plugin
into `~/.codex/plugins/icloud-mail/`, and installs `icloud-mail@personal`.
Codex loads its cache copy under `~/.codex/plugins/cache/personal/icloud-mail/`.
Use the installed path reported by the command to identify the current version.
Only one installation is needed. Start a new chat after an update.

The MCP uses `/opt/homebrew/bin/node` on this Mac. Update `.mcp.json` before
installing on a Mac with a different Node.js location. Node.js 20+ and the
existing iCloud account configuration are required.

For read-only live verification, optionally pass the installed plugin path:

```sh
node scripts/verify-icloud-plugin.mjs
```

The verifier authenticates IMAP/SMTP, searches and reads mail, retrieves the
signature, and previews a threaded reply. It does not send or create drafts.

## Persistent configuration

- `~/Library/Application Support/apple-mail-mcp/config.json`: account settings
  and macOS Keychain references. Passwords remain in Keychain.
- `~/.codex/integrations/icloud-mail/preferences.json`: primary address and
  per-sender signatures.
- `~/.codex/integrations/icloud-mail/drafts.json`: stable draft IDs, revisions,
  and send state.

These files are not packaged or erased by an update. `ICLOUD_MAIL_DATA_DIR` can
select another preferences/draft directory; the default preserves existing
state. `APPLE_MAIL_MCP_CONFIG_FILE` can select another account configuration.

The old integration directory is now data only. All maintained source and
build tooling live in this repository. To rebuild:

```sh
pnpm build:plugin
node scripts/install-icloud-plugin.mjs
```

`server/provenance.json` records the bundle hash and source inputs. To remove
the plugin while preserving mail data:

```sh
codex plugin remove icloud-mail@personal
```
