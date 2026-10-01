# Remote connector (claude.ai, desktop and mobile)

The same bundle runs as a remote MCP server over Streamable HTTP. Added once as
a claude.ai custom connector, it follows your Claude account to the web,
desktop and mobile apps with nothing installed per device.

```text
Claude (any device) ──HTTPS──▶ tunnel / reverse proxy ──▶ server.cjs --http ──▶ iCloud IMAP/SMTP
```

## Security model

- Every `/mcp` request needs an OAuth bearer token. The server is its own
  single-owner OAuth 2.1 authorization server: clients may register
  dynamically, but each connection must be approved on a page that asks for
  `ICLOUD_MAIL_OWNER_PASSWORD`.
- Registration accepts only the claude.ai/claude.com callbacks and loopback
  (`http://localhost`, `127.0.0.1`, `[::1]`) callbacks. Add others with
  `ICLOUD_MAIL_OAUTH_REDIRECT_URIS` (comma-separated, exact match).
- PKCE (S256) is required. Codes are single use and expire after 5 minutes.
  Access tokens last 1 hour and refresh tokens 30 days, rotating on each use.
  Tokens are bound to `<ICLOUD_MAIL_PUBLIC_URL>/mcp` and stored only as SHA-256
  hashes in `oauth.json` (mode 0600).
- Approval attempts are rate limited per client IP. After 10 failed passwords
  within an hour, approval is locked for everyone until the hour passes.
- Remote callers cannot attach files by server path; attachments must be
  inline `{filename, contentBase64}`.
- The server listens on `127.0.0.1` by default. Expose it only through HTTPS.

To revoke every connection, stop the server and delete `oauth.json`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ICLOUD_MAIL_TRANSPORT=http` or `--http` | stdio | Serve over HTTP |
| `ICLOUD_MAIL_PUBLIC_URL` | required | Public HTTPS origin, e.g. `https://mail.example.com` |
| `ICLOUD_MAIL_OWNER_PASSWORD` | required | Approves OAuth clients; at least 16 characters |
| `ICLOUD_MAIL_HTTP_HOST` | `127.0.0.1` | Bind address |
| `ICLOUD_MAIL_HTTP_PORT` | `8787` | Bind port |
| `ICLOUD_MAIL_TRUST_PROXY` | `loopback` | Express `trust proxy`, for client IPs behind a proxy |
| `ICLOUD_MAIL_OAUTH_REDIRECT_URIS` | — | Extra allowed OAuth callbacks |
| `ICLOUD_MAIL_OAUTH_STORE` | `<data dir>/oauth.json` | OAuth client and token store |

Account settings are the usual `APPLE_MAIL_MCP_*` variables. On Linux there is
no Keychain, so set `APPLE_MAIL_MCP_IMAP_PASSWORD` and
`APPLE_MAIL_MCP_SMTP_PASSWORD` to an Apple app-specific password. The data
directory (`ICLOUD_MAIL_DATA_DIR`) must contain `preferences.json`.

## Option A: Docker with Cloudflare Tunnel

1. In Cloudflare Zero Trust, create a tunnel with a public hostname such as
   `mail.example.com` pointing to `http://icloud-mail:8787`. Copy its token.
2. Prepare the data directory and environment:

   ```sh
   cd deploy
   cp icloud-mail.env.example icloud-mail.env   # fill in passwords and URL
   mkdir -p data && cp ~/.codex/integrations/icloud-mail/preferences.json data/
   sudo chown -R 1000:1000 data                  # the container runs as "node"
   ```

3. Start it:

   ```sh
   TUNNEL_TOKEN=... docker compose up -d --build
   curl https://mail.example.com/healthz
   ```

## Option B: Tailscale Funnel on an always-on machine

```sh
export ICLOUD_MAIL_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
export ICLOUD_MAIL_OWNER_PASSWORD='…'
node plugins/icloud-mail/server/server.cjs --http &
tailscale funnel --bg 8787
```

Funnel makes the server reachable from Anthropic's servers; a tailnet-only
address is not enough for claude.ai. On a Mac the existing Keychain
configuration works unchanged.

## Connect Claude

- **claude.ai** (and with it the desktop and mobile apps): Settings →
  Connectors → Add custom connector, URL `https://mail.example.com/mcp`.
  Approve with the owner password when the page opens.
- **Claude Code** on a machine without the plugin:

  ```sh
  claude mcp add --transport http icloud-mail https://mail.example.com/mcp
  ```

  then run `/mcp` to authenticate.

## Multiple devices and drafts

The server's Drafts mailbox is the source of truth. Each draft carries its
connector ID in a header, so any device or server instance can find, edit and
send it; the local `drafts.json` is only a cache. While a send is in flight or
its outcome is uncertain, the server copy carries the `$IcloudMailSending`
keyword, and every other instance refuses to send it until the outcome is
resolved. Before submitting, the connector also checks Sent for the same
Message-ID, so a draft whose cleanup failed is never sent twice.
