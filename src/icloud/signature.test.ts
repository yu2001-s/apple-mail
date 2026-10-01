import assert from "node:assert/strict";
import { test } from "vitest";
import { withSignature } from "./signature.js";

const sender = "primary@example.com";
const signature = "Example Sender\nExample Company\nprimary@example.com\n+1 555 0100";
const preferences = { signatures: { [sender]: signature } };
const apply = (input: Parameters<typeof withSignature>[0]) =>
  withSignature(input, preferences, sender);

test("new message gets the exact saved four-line signature, once across repeated edits", () => {
  const draft = apply({ from: sender, body: "陳主任您好：\n\n資料附上，謝謝！" });
  assert.equal(draft.body, `陳主任您好：\n\n資料附上，謝謝！\n\n${signature}`);
  assert.deepEqual(apply(draft), draft);
});

test("a manually included signature with CRLF and trailing spaces is preserved byte-for-byte", () => {
  const body = `謝謝！\r\n\r\n${signature.replaceAll("\n", "  \r\n")}\r\n`;
  assert.equal(apply({ body }).body, body);
});

test("quoted history does not suppress the new signature or move it below history", () => {
  const history = `On Tuesday, Peter wrote:\n${signature
    .split("\n")
    .map((s) => `> ${s}`)
    .join("\n")}`;
  const draft = apply({ body: `謝謝回覆。\n\n${history}` });
  assert.equal(draft.body, `謝謝回覆。\n\n${signature}\n\n${history}`);
  assert.deepEqual(apply(draft), draft);
});

test("HTML and plain-text alternatives agree, with HTML inserted inside body before quoted history", () => {
  const draft = apply({
    body: "謝謝！",
    htmlBody: "<html><body><p>謝謝！</p><blockquote>舊信</blockquote></body></html>",
  });
  assert.equal(draft.body, `謝謝！\n\n${signature}`);
  assert.match(
    draft.htmlBody,
    /Example Sender<br>Example Company<br>primary@example.com<br>\+1 555 0100<\/div><blockquote>/
  );
  assert.ok(draft.htmlBody.endsWith("</body></html>"));
  assert.deepEqual(apply(draft), draft);
  const withoutQuote = apply({ htmlBody: "<html><body>您好</body></html>" });
  assert.ok(
    withoutQuote.htmlBody.indexOf("Example Sender") < withoutQuote.htmlBody.indexOf("</body>")
  );
});

test("manually formatted HTML signature is not duplicated", () => {
  const htmlBody =
    '<p>Example Sender</p><p>Example Company</p><p><a href="mailto:primary@example.com">primary@example.com</a></p><p>+1&nbsp;555&nbsp;0100</p>';
  assert.equal(apply({ htmlBody }).htmlBody, htmlBody);
});

test("explicit opt-out and other sender addresses never acquire the Example Company signature", () => {
  assert.deepEqual(apply({ body: "Custom sign-off", includeSignature: false }), {
    body: "Custom sign-off",
  });
  assert.deepEqual(apply({ body: "Hello", from: "other@example.com" }), {
    body: "Hello",
    from: "other@example.com",
  });
});

test("attachment-only updates and removal of HTML do not create or replace any body", () => {
  const update = { expectedRevision: "revision", attachmentsToAdd: ["/tmp/brief.pdf"] };
  assert.deepEqual(apply(update), update);
  assert.deepEqual(apply({ htmlBody: null }), { htmlBody: null });
});
