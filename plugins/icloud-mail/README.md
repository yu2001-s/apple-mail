# iCloud Mail Codex Plugin

This packages the existing customized iCloud connector, version 1.2.0, as an
independently installable Codex Plugin. The bundled runtime is copied byte for
byte from the working connector, including its dependencies. Installation does
not require `npm install`, the upstream checkout, Mail.app, or AppleScript.

## Install on this Mac

From the repository root:

```sh
node scripts/package-icloud-plugin.mjs
node scripts/install-icloud-plugin.mjs
```

The installer copies the source to `~/.codex/plugins/icloud-mail/`, adds it to
`~/.agents/plugins/marketplace.json` while preserving other entries, and installs
`icloud-mail@personal`. This personal source is discoverable from other project
directories. The plugin displays as **iCloud Mail**, separately from the existing
Apple Mail plugin. The MCP uses `/opt/homebrew/bin/node`, matching the previous registration
on this Mac; update `.mcp.json` before installing on a Mac with a different Node
location. Node.js 20 or newer and the existing account configuration are required.

After installation, verify the installed cache copy, then remove the old
standalone registration to avoid loading the same connector twice:

```sh
node scripts/verify-icloud-plugin.mjs ~/.codex/plugins/cache/personal/icloud-mail/1.2.0
codex mcp remove icloud-mail
```

Use the cache path reported by `codex plugin add` if it differs. The verification
performs authentication, search, message reads, signature retrieval, and reply
previews. It does not create drafts, mark mail read, or send messages. Start a
new chat or reconnect the MCP after changing the registration; an existing chat
may retain its previously loaded tool catalog.

## Persistent data and credentials

The runtime intentionally preserves the old storage locations:

- `~/Library/Application Support/apple-mail-mcp/config.json`: account settings
  and macOS Keychain references.
- `~/.codex/integrations/icloud-mail/preferences.json`: primary address and
  per-sender signatures.
- `~/.codex/integrations/icloud-mail/drafts.json`: stable draft IDs, revisions,
  and send states.

These files and passwords are not included in the plugin. Reinstalling or
removing the plugin does not erase them. Keep the original integration directory.

## Updating the package

`scripts/package-icloud-plugin.mjs [connector-directory]` imports only the
prebuilt `server.cjs` and the upstream MIT license, checks the connector's
version against the manifest, and records the bundle SHA-256 in
`server/provenance.json`. It deliberately does not rebuild unrelated local source
changes into the working connector. The original integration retains its source
and build script. After updating that connector, update the plugin and marketplace
versions, package again, and run the installer to refresh the personal source
and installed cache copy. The repo marketplace also exposes the plugin as
`icloud-mail@apple-mail-public` for repo distribution; install only one copy.

The registry is shared with the old connector; operate only one registration at
a time after migration. To roll back, remove this plugin and re-register the old
connector:

```sh
codex plugin remove icloud-mail@personal
codex mcp add icloud-mail -- /opt/homebrew/bin/node "$HOME/.codex/integrations/icloud-mail/server.cjs"
```
