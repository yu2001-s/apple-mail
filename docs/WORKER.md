# Cloudflare Worker deployment

Run the connector on Cloudflare instead of your own machine. Add it once to
your Claude and ChatGPT accounts and it follows you to every device: nothing
is installed per device and no computer has to stay on.

```text
Claude / ChatGPT (any device) ──HTTPS──▶ Worker: OAuth + MCP ──TLS──▶ iCloud IMAP / SMTP
                                            │
                                            └─ KV: OAuth clients and grants only
```

## Deploy

Requires a Cloudflare account. From the repository, on the Mac that already
has the iCloud configuration:

```sh
pnpm install --frozen-lockfile
npx wrangler login
node scripts/setup-worker.mjs
```

The script deploys the Worker (creating its KV namespace), then uploads
everything personal as encrypted Worker secrets: your addresses, the app
passwords read from Keychain, your preferences and signatures, and a new
owner password, which it prints once. Save that password; it approves every
connection. Nothing personal is committed to `wrangler.jsonc`.

Settings are edited from chat afterwards, for example "make hello@example.com
my default sender" or "change my signature for me@example.com". They are
stored in the Worker's KV; the `ICLOUD_MAIL_PREFERENCES` secret only seeds
them on first use. To update account secrets such as an app password:

```sh
node scripts/setup-worker.mjs --secrets
```

Later runs keep the existing owner password; set `ICLOUD_MAIL_OWNER_PASSWORD`
in the environment to choose or rotate it. Rotating it does not disconnect
clients you already approved. Redeploy code changes with
`npx wrangler deploy`.

The Worker URL is `https://icloud-mail.<your-subdomain>.workers.dev`; a custom
domain can be added in the Cloudflare dashboard. If it answers on more than one
hostname, set `ICLOUD_MAIL_PUBLIC_URL` so tokens are bound to one origin.

## Connect

The connector URL is `<Worker URL>/mcp`. Each connection opens an approval page
that asks for the owner password.

- **Claude**: Settings → Connectors → Add custom connector. A connector added
  on claude.ai is available in the web, desktop and mobile apps.
- **ChatGPT**: Settings → Apps & Connectors → Advanced settings → Developer
  mode, then Create, with the URL and OAuth authentication. ChatGPT limits
  which plans may use custom connectors and their write actions, and whether
  they work in its mobile apps is not documented; check your plan.
- **Claude Code** on any machine:

  ```sh
  claude mcp add --transport http icloud-mail https://icloud-mail.<your-subdomain>.workers.dev/mcp
  ```

After changing tool parameters, deploy the Worker, then open the existing
iCloud Mail plugin in ChatGPT, choose **Manage**, and select **Refresh tools**.
Start a new conversation if the host still has the old tool definitions.
See [OpenAI's metadata refresh guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
ID patterns must match the complete value: `^imap:[A-Za-z0-9_-]+$` works with
the host's full-match validation, while a prefix-only `^imap:` does not.

## Security

- `@cloudflare/workers-oauth-provider` implements OAuth 2.1: PKCE, single-use
  codes, rotating refresh tokens, tokens bound to the `/mcp` resource, and only
  hashes of tokens and secrets in KV. Access tokens last 1 hour; grants 30 days.
- Clients may register dynamically (Claude) or present a Client ID Metadata
  Document (ChatGPT), but codes are only ever sent to the claude.ai,
  claude.com and chatgpt.com connector callbacks or to a loopback address. Add
  exact callbacks with `ICLOUD_MAIL_OAUTH_REDIRECT_URIS`.
- The approval page is bound to the browser that opened it and cannot be
  framed. After 10 wrong owner passwords in an hour, approval is locked for
  everyone until the hour passes.
- Attachments must be sent inline; the Worker has no files to read.

To revoke every connection, delete the entries in the Worker's `OAUTH_KV`
namespace from the Cloudflare dashboard; each client then has to be approved
again with the owner password.

## How it differs from the local plugin

Each request builds a fresh connector with one IMAP connection that is logged
out at the end. The Worker keeps no draft state: drafts are found on iCloud by
their ID header and the `$IcloudMailSending` keyword marks an unresolved send,
exactly as between two devices (see [REMOTE.md](REMOTE.md#multiple-devices-and-drafts)).

Each tool call takes a few seconds, mostly connecting to iCloud. On the
Workers Free plan a request may use 10 ms of CPU time; reading large messages
can exceed it, which fails that call. Workers Paid raises the limit.

## Test locally

```sh
pnpm test:worker
```

This runs the Worker in local workerd with synthetic settings and walks the
complete OAuth flow and tool discovery without contacting iCloud.
