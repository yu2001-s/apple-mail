# Contributing

This repository maintains one connector, the Cloudflare Worker in
`src/worker/`. Keep tool contracts and server instructions in the MCP server.

Use the pinned pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:worker
```

Never commit account preferences, passwords, tokens or Keychain contents.
Personal values are Worker secrets set by `scripts/setup-worker.mjs`; tests use
synthetic configuration.

For a runtime change, bump `package.json` with
`pnpm version patch --no-git-tag-version` (it also updates the version in
`wrangler.jsonc`), add a changelog entry, and deploy with
`npx wrangler deploy`.

GreenMail integration tests run with `RUN_IMAP_IT=1 pnpm test:imap`.
