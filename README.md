# iCloud Mail

One Codex Plugin for direct iCloud IMAP/SMTP access. It searches and reads mail,
creates synchronized drafts, resolves threaded replies, and applies saved
sender signatures. It does not launch Mail.app or use AppleScript.

The bundled runtime and minimal Skill live in `plugins/icloud-mail/`. Only this
connector is listed in the repository marketplace.

## Install

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
macOS Keychain. Primary address, signatures, and draft IDs/revisions remain in
`~/.codex/integrations/icloud-mail/preferences.json` and `drafts.json`. These are
user data, separate from the plugin package. Keep them across upgrades.

## Develop

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build:plugin
pnpm test
```

`src/icloud/server.ts` is the only MCP entrypoint. The shared IMAP, SMTP, MIME,
and draft modules remain under `src/`. `pnpm build:plugin` builds the standalone
bundle directly from these sources and records its SHA-256 and source inputs.
It does not read an older installed connector. After changing source, rebuild
and run the installer to update the personal source and cache copy.

The standalone boot test copies the plugin into a temporary directory with no
`node_modules`, uses synthetic preferences, and checks MCP discovery and
signature retrieval without contacting iCloud. For live validation:

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
