# Changelog

## 1.5.0 — 2026-10-05

- Serve MCP on the Worker from a Durable Object that keeps one IMAP
  connection open across tool calls, closing it after three idle minutes.
- Run the Worker next to iCloud's IMAP servers (`placement.host`).
- iCloud-backed tool calls measured from Taipei: 3.0-4.4 s before, about
  0.6 s now, most of it the network trip to the Worker.

## 1.4.1 — 2026-10-02

- Publish optional tool arguments as nullable in JSON Schema. ChatGPT
  validates arguments against the schema itself and rejected the `null` it
  sends for unset fields before the request reached the server.

## 1.4.0 — 2026-10-02

- Settings editable from chat: `update_settings` changes the primary (default)
  sender and the sending addresses, `set_signature` sets or clears a
  sender's signature. Settings live in `settings.json` locally and in KV on
  the Worker, seeded from the existing configuration on first use.
- Discover sending addresses: `list_sending_addresses` adds addresses used in
  Sent (rescanned daily, or with `refresh`) and suggests custom-domain
  recipients from the inbox. Addresses the user removed are never re-added.
- Tool schemas and descriptions no longer embed addresses, so settings
  changes need no tool refresh in ChatGPT; sender addresses are checked at
  run time, including at send time for existing drafts.
- Inline every schema field instead of emitting `$ref`.

## 1.3.1 — 2026-10-02

- Publish ID patterns ChatGPT's connector validator accepts: no escaped
  punctuation (zod's `startsWith()` emitted `^imap\:`) and anchored to the
  whole value (`^imap:[A-Za-z0-9_-]+$`), since it requires a full match.
- Lower `read_message`'s minimum `maxBodyChars` to 100.
- Accept `null` for optional tool arguments, as strict-mode clients such as
  ChatGPT send; `update_draft` now removes the HTML part only for an empty
  `htmlBody` string.
- Drop the repository plugin marketplaces in favour of the account-level
  Worker connector; the plugin directory still loads with `--plugin-dir`.

## 1.3.0 — 2026-10-01

- Package the connector as a Claude Code plugin with a repository
  marketplace, alongside the Codex Plugin.
- Start the server through a portable launcher that finds Node.js 20+ instead
  of a hard-coded Homebrew path.
- Treat the iCloud Drafts mailbox as the source of truth: drafts from other
  devices are recovered by their ID header, a `$IcloudMailSending` keyword
  blocks duplicate sends across devices, and a Sent Message-ID check prevents
  resending a draft whose cleanup failed.
- Add a remote Streamable HTTP mode with a built-in single-owner OAuth 2.1
  server for claude.ai custom connectors, plus Docker and Cloudflare Tunnel
  deployment files.
- Accept inline base64 attachments; remote callers cannot attach server files.
- Deploy as a Cloudflare Worker (`scripts/setup-worker.mjs`): OAuth through
  `@cloudflare/workers-oauth-provider` with dynamic registration for Claude and
  Client ID Metadata Documents for ChatGPT, secrets loaded from the existing
  Keychain configuration, and no per-device installation.
- Accept ChatGPT connector OAuth callbacks alongside Claude's.
- Fix an ImapFlow lost-wakeup race that stalled the first command after login
  in the Workers runtime.

## 1.2.1 — 2026-10-01

- Consolidate on the direct iCloud Mail Plugin; remove the obsolete Apple Mail
  connector, its bundles, Skill, launch entrypoints, and automation code.
- Move the customized iCloud source and signature tests into the repository;
  build the standalone plugin here instead of copying an older installation.
- Preserve existing preferences, draft IDs/revisions, account configuration,
  and Keychain credentials.
- Keep one marketplace entry and add an isolated standalone boot check.

## 1.2.0 — 2026-10-01

- Package the customized iCloud MCP as a personal Codex Plugin.
- Add direct mail/reply verification and a minimal usage Skill.

Earlier upstream history remains in Git.
