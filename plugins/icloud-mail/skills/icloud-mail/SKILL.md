---
name: icloud-mail
description: Read, compose, and reply to iCloud email through this plugin's MCP tools.
---

# iCloud Mail

Use `preview_reply` for previews. For a requested reply, `create_reply_draft` resolves recipients and threading and returns a server-verified draft. When sending is authorized, pass the returned draft's `draftId` and `revision` to `send_draft` as `draftId` and `expectedRevision`. Call `get_draft` again only if the draft may have changed.

Do not automatically retry an uncertain send or create a replacement draft to bypass its send state.
