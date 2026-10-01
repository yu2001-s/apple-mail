# Changelog

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
