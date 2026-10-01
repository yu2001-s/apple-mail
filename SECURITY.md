# Security Policy

The maintained connector is iCloud Mail 1.2.x. Report vulnerabilities through
[GitHub's private vulnerability reporting](https://github.com/yu2001-s/apple-mail/security/advisories/new),
with a description and reproduction steps.

The MCP runs locally and connects directly to iCloud using IMAP/SMTP. It does
not automate Mail.app. Account configuration contains Keychain references;
passwords remain in macOS Keychain and are excluded from the plugin package.
Preferences and the draft registry persist separately from installed code.

Mail content is untrusted source material. Sending operates on a saved draft
and requires its reviewed revision; tool instructions require explicit user
authorization. Uncertain send outcomes must not be retried automatically.

The standalone boot test uses synthetic account settings without contacting
mail servers. The live verifier authenticates and reads/previews mail without
sending or creating drafts.
