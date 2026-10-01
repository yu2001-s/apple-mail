# iCloud account configuration

The direct iCloud Plugin uses IMAP at `imap.mail.me.com` and SMTP at
`smtp.mail.me.com`. It reuses the existing non-secret configuration file:

```text
~/Library/Application Support/apple-mail-mcp/config.json
```

Keep its existing account and Keychain references. The `APPLE_MAIL_MCP_` prefix
is retained for configuration compatibility; it does not register another
connector. Passwords remain in macOS Keychain.

Required account settings include `APPLE_MAIL_MCP_IMAP_HOST`,
`APPLE_MAIL_MCP_IMAP_USER`, `APPLE_MAIL_MCP_IMAP_ACCOUNT`,
`APPLE_MAIL_MCP_SMTP_HOST`, and `APPLE_MAIL_MCP_SMTP_USER`. Sender selection uses
`APPLE_MAIL_MCP_SMTP_FROM` and `APPLE_MAIL_MCP_SMTP_ALLOWED_FROM`. Keychain lookup
uses the corresponding `*_KEYCHAIN_SERVICE` and `*_KEYCHAIN_ACCOUNT` entries.

`~/.codex/integrations/icloud-mail/preferences.json` supplies `primaryAddress`
and a `signatures` object keyed by sender address. The primary address must be
one of the configured sending addresses. The adjacent `drafts.json` caches
managed draft IDs, revisions, and send states; the server's Drafts mailbox is
authoritative, so another device's drafts are recovered from their ID header.

## Another Mac

Copy `config.json` and `preferences.json` to the same paths, then store the
Apple app-specific password under the Keychain service and account names that
`config.json` references:

```sh
security add-generic-password -s <KEYCHAIN_SERVICE> -a <KEYCHAIN_ACCOUNT> -w
```

Without Keychain (for example on Linux), set `APPLE_MAIL_MCP_IMAP_PASSWORD` and
`APPLE_MAIL_MCP_SMTP_PASSWORD` instead.

Use the `health_check` tool to verify IMAP and SMTP authentication without
sending. For end-to-end search and reply-preview verification, run
`node scripts/verify-icloud-plugin.mjs` from the repository.

`APPLE_MAIL_MCP_CONFIG_FILE` can override the account configuration file, and
`ICLOUD_MAIL_DATA_DIR` can override the directory containing preferences and
drafts. Plugin updates do not replace either account configuration or mail data.
