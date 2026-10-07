import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "./htmlText.js";

describe("htmlToText", () => {
  it("keeps paragraphs, list items and link targets", () => {
    const html = `<html><head><style>p{color:red}</style><title>x</title></head><body>
<p>Hello&nbsp;there,</p><div>Your order <b>#12</b> shipped.</div>
<ul><li>One</li><li>Two &amp; three</li></ul>
<p><a href="https://track.example/1?a=1&amp;b=2">Track it</a> or <a href="mailto:x@y.z">mail us</a>.</p>
<script>alert(1)</script><!-- hidden --></body></html>`;
    expect(htmlToText(html)).toBe(
      "Hello there,\n\nYour order #12 shipped.\n\n- One\n- Two & three\n\nTrack it (https://track.example/1?a=1&b=2) or mail us."
    );
  });

  it("does not repeat a link whose text is its URL", () => {
    expect(htmlToText('<a href="https://a.example">https://a.example</a>')).toBe(
      "https://a.example"
    );
  });

  it("decodes numeric entities", () => {
    expect(decodeEntities("&#20013;&#x6587; &rsquo;&unknown;")).toBe("中文 ’&unknown;");
  });
});
