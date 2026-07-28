---
name: apple-mail
description: Manage Apple Mail on macOS with Gmail-like draft resources, future send scheduling, and explicit sending identities. Use for searching or reading mail, listing sender aliases, selecting a From identity, creating/reviewing/updating/sending/scheduling/deleting drafts, replying, forwarding, organizing messages, or diagnosing Apple Mail connectivity.
---

# Apple Mail

Treat receiving accounts, sending identities, messages, threads, and drafts as different resources.

## Draft workflow

1. Call `list-sending-identities` before the first compose action when the user has multiple aliases or names a From address.
2. Pass the exact `identity_id` or email in `from`. Do not pass an account label when the user selected a specific alias.
3. Call `create-draft`; retain its returned `draft_id`.
4. Use `list-drafts` for summaries. It indexes the actual saved Drafts mailboxes across accounts, not only currently open compose windows. Then use `read-draft` before a consequential edit, send, or delete.
5. Use `update-draft` for targeted changes. Omitted fields are preserved. The connector keeps the same `draft_id` even when Mail requires a verified replacement internally.
6. Use `send-draft` only after the user reviewed that exact draft or explicitly asked to send it.
7. Use `delete-draft` only after explicit confirmation of that exact `draft_id`.

Do not recreate drafts manually, search by subject as a substitute for `draft_id`, or use UI automation for ordinary draft edits.

Drafts with attachments are not editable or sendable through the draft mutation tools because Mail's scripting bridge cannot safely preserve their MIME structure. Edit or send those drafts in Mail.app.

## Scheduled sends

1. Use `schedule-drafts` only after the user reviewed the exact drafts and explicitly confirmed every draft, recipient/content, From identity, future time, and timezone.
2. Convert natural-language times to RFC 3339 with an explicit offset, such as `2026-07-29T07:00:00+08:00`. Never infer an omitted timezone.
3. Pass every reviewed `draft_id` in one atomic batch and set `confirmed=true`.
4. Call `list-scheduled-sends` after scheduling and report every returned `schedule_id`.
5. A scheduled draft is locked against plugin update, manual send, and delete. Use `cancel-scheduled-send` before changing it.
6. Use `reschedule-scheduled-send` only after explicit confirmation of the exact schedule and new timezone-aware time.
7. If a job is `failed` or `needs_review`, do not resend automatically. Read the error, re-review the draft, and ask the user what to do.

The scheduler is a local launchd worker, not Mail's native Send Later mailbox because Mail exposes no public scripting command for that UI feature. It checks every 30 seconds, sends overdue jobs after wake/login, and requires the Mac user session to remain logged in. Drafts with attachments are refused. Immediately before sending, it verifies that the reviewed From, recipients, subject, and body have not changed.

## Sending identities

- `list-accounts` returns receiving accounts and all configured addresses.
- `list-sending-identities` returns each usable From alias separately.
- `set-default-sending-identity` changes only this connector's reversible local preference; it does not modify Mail settings.
- For one message, prefer the `from` parameter instead of changing the default.
- Verify the actual `from` returned by `create-draft` or `read-draft`; never infer success from the requested selector alone.

## Reading and organization

- Use `search-messages` to obtain message IDs, `get-message` for one body, and `get-thread` when conversation context affects the answer.
- Preserve `account` and `mailbox` hints from search/list results for reliable reads.
- Use batch tools only after inspecting the exact IDs.
- Treat partial search diagnostics as incomplete coverage, not confirmed absence.

## Safety

- Draft creation and updates do not send mail.
- Sending, replies with `send=true`, forwards with `send=true`, and serial email require explicit confirmation.
- Message, draft, mailbox, rule, and template deletion require explicit confirmation and a prior read/list.
- Never report success unless the tool returned the actual draft/message identifier and requested state.

## Recovery

- If a draft ID is not found, call `list-drafts` once and ask the user to select the current draft. Do not guess by subject.
- Run `doctor` for permissions, account, IMAP, or SMTP failures.
- Apple Mail is a local aggregator rather than a provider API. Prefer configured IMAP/SMTP paths for large mailboxes and clean MIME delivery.
