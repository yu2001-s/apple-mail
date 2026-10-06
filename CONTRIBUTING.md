# Contributing

This repository maintains one direct iCloud Mail connector. Its entrypoint is
`src/icloud/server.ts`; `plugins/icloud-mail/` is the only published plugin.
Keep tool contracts and server instructions in the MCP. Keep the Skill minimal.

Use the pinned pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build:plugin
```

Never commit account preferences, draft registries, passwords, or Keychain
contents. The standalone boot test uses synthetic configuration; the live
verifier reads mail and authenticates without creating drafts or sending.

For a runtime change, bump `package.json`, run
`node scripts/sync-plugin-version.mjs`, add a changelog entry, rebuild, and
commit the new `plugins/icloud-mail/server/` files. A clean build must leave the
committed bundle unchanged, and the bundle must boot without runtime
dependencies on Node 20 (`node --test test/plugin-boot.test.mjs`). The
pre-commit hook rebuilds when connector inputs are staged; commit from a
checkout without unrelated source edits so they do not enter the bundle.

GreenMail integration tests run with `RUN_IMAP_IT=1 pnpm test:imap`.
