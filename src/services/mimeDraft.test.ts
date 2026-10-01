import { describe, expect, it } from "vitest";
import {
  composeDraftMime,
  DRAFT_ID_HEADER,
  draftIdFromMime,
  draftMimeRevision,
  parseDraftMime,
  prepareDraftMimeForSend,
} from "@/services/mimeDraft.js";

describe("draft MIME composition", () => {
  it("reads the connector draft id back from the stored headers only", async () => {
    const raw = await composeDraftMime({
      draftUuid: "00000000-0000-4000-8000-0000000000aa",
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Id",
      body: `${DRAFT_ID_HEADER}: not-a-header`,
    });
    expect(draftIdFromMime(raw)).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(draftIdFromMime(prepareDraftMimeForSend(raw))).toBeUndefined();
  });

  it("round-trips folded reply references and retains them on the delivered MIME", async () => {
    const references = Array.from({ length: 8 }, (_, i) => `<conversation-${i}@example.com>`);
    const raw = await composeDraftMime({
      draftUuid: "reply-test",
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Re: 醫療減負合作交流",
      body: "謝謝您協助轉介！",
      inReplyTo: references.at(-1),
      references,
    });
    for (const mime of [raw, prepareDraftMimeForSend(raw)]) {
      expect(parseDraftMime(mime)).toMatchObject({
        inReplyTo: references.at(-1),
        references,
        subject: "Re: 醫療減負合作交流",
        body: "謝謝您協助轉介！",
      });
    }
  });

  it("round-trips unicode text, HTML, Bcc, and duplicate attachment names", async () => {
    const raw = await composeDraftMime({
      draftUuid: "00000000-0000-4000-8000-000000000001",
      from: "寄件人 <sender@example.com>",
      to: ["to@example.com"],
      bcc: ["hidden@example.com"],
      subject: "測試主旨",
      body: "純文字內容",
      htmlBody: "<p>HTML 內容</p>",
      attachments: [
        { filename: "same.txt", content: Buffer.from("one"), contentType: "text/plain" },
        { filename: "same.txt", content: Buffer.from("two"), contentType: "text/plain" },
      ],
    });

    const parsed = parseDraftMime(raw);
    expect(parsed.from).toContain("sender@example.com");
    expect(parsed.bcc).toEqual(["hidden@example.com"]);
    expect(parsed.subject).toBe("測試主旨");
    expect(parsed.body).toContain("純文字內容");
    expect(parsed.htmlBody).toContain("HTML 內容");
    expect(parsed.attachments.map((item) => item.content.toString())).toEqual(["one", "two"]);
    expect(raw.toString()).toContain(`${DRAFT_ID_HEADER}:`);
    expect(draftMimeRevision(raw)).toHaveLength(64);
  });

  it("removes Bcc and private connector headers before SMTP delivery", async () => {
    const raw = await composeDraftMime({
      draftUuid: "00000000-0000-4000-8000-000000000001",
      from: "sender@example.com",
      to: ["to@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Safe headers",
      body: "Body",
    });

    const deliverable = prepareDraftMimeForSend(raw).toString();
    expect(deliverable).not.toMatch(/^Bcc:/im);
    expect(deliverable).not.toMatch(/^X-Apple-Mail-Plugin-Draft-ID:/im);
    expect(deliverable).toContain("Body");
  });

  it("round-trips long subjects split across adjacent encoded words", async () => {
    const subject = "[Apple Mail Plugin Test] Edited draft + SMTP send — 2026-07-29";
    const raw = await composeDraftMime({
      draftUuid: "00000000-0000-4000-8000-000000000001",
      from: "sender@example.com",
      to: ["to@example.com"],
      subject,
      body: "Body",
    });

    expect(raw.toString()).toMatch(/Subject: =\?UTF-8\?Q\?.+\r?\n =\?UTF-8\?Q\?/);
    expect(parseDraftMime(raw).subject).toBe(subject);
  });
});
