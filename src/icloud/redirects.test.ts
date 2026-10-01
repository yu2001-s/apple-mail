import { describe, expect, it } from "vitest";
import { formActionSources, isAllowedRedirect, parseRedirectList } from "@/icloud/redirects.js";

describe("OAuth redirect allowlist", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/abc_DEF-123",
    "http://localhost:53682/callback",
    "http://127.0.0.1:9000/oauth/callback",
  ])("accepts %s", (uri) => expect(isAllowedRedirect(uri)).toBe(true));

  it.each([
    "https://evil.example/callback",
    "https://claude.ai/api/mcp/auth_callback/extra",
    "https://chatgpt.com/connector/oauth/abc/../../steal",
    "https://chatgpt.com/connector/oauth/abc?next=https://evil.example",
    "https://chatgpt.com:444/connector/oauth/abc",
    "https://user@chatgpt.com/connector/oauth/abc",
    "http://chatgpt.com/connector/oauth/abc",
    "https://chatgpt.com.evil.example/connector/oauth/abc",
    "http://evil.example/callback",
    "not a url",
  ])("rejects %s", (uri) => expect(isAllowedRedirect(uri)).toBe(false));

  it("accepts configured exact callbacks", () => {
    const extra = parseRedirectList(" https://app.example/cb ,,https://other.example/cb");
    expect(extra).toEqual(["https://app.example/cb", "https://other.example/cb"]);
    expect(isAllowedRedirect("https://app.example/cb", extra)).toBe(true);
    expect(isAllowedRedirect("https://app.example/cb2", extra)).toBe(false);
  });

  it("lists every callback origin as a form-action source", () => {
    const sources = formActionSources(["https://app.example/cb", "bad"]).split(" ");
    expect(sources).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://claude.ai",
        "https://chatgpt.com",
        "https://app.example",
      ])
    );
    expect(sources).not.toContain("bad");
  });
});
