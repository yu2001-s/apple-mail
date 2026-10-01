# iCloud Mail Plugin

A standalone Claude Code and Codex Plugin for iCloud IMAP/SMTP, threaded
replies, revision-checked drafts, and saved sender signatures. The repository contains
its source and bundled dependencies. Mail.app and AppleScript are not required.

## Install and update

In Claude Code:

```sh
claude plugin marketplace add yu2001-s/apple-mail
claude plugin install icloud-mail@icloud-mail
```

In Codex, from the repository root:

```sh
node scripts/install-icloud-plugin.mjs
```

The installer preserves other personal marketplace entries, copies this plugin
into `~/.codex/plugins/icloud-mail/`, and installs `icloud-mail@personal`.
Codex loads its cache copy under `~/.codex/plugins/cache/personal/icloud-mail/`.
Use the installed path reported by the command to identify the current version.
Only one installation is needed. Start a new chat after an update.

Both hosts start `server/launch.sh`, which runs `server.cjs` with the first
Node.js 20+ in `PATH`, Homebrew, Volta or nvm; set `ICLOUD_MAIL_NODE` to choose
one. The existing iCloud account configuration is required.

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
- `~/.codex/integrations/icloud-mail/drafts.json`: a per-device cache of draft
  IDs, revisions, and send state. The server's Drafts mailbox is authoritative,
  so drafts made on another device or by the remote server are found by their
  ID header.

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
claude plugin uninstall icloud-mail@icloud-mail
```

To run the connector as a remote server for claude.ai, see
[docs/REMOTE.md](../../docs/REMOTE.md).
