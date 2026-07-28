import { describe, it, expect } from "vitest";
import { buildSearchCondition } from "@/services/appleMailManager.js";

describe("buildSearchCondition", () => {
  it("returns an empty string when no filters are set", () => {
    expect(buildSearchCondition({})).toBe("");
    expect(buildSearchCondition({ query: "" })).toBe("");
  });

  it("builds a parenthesized subject-OR-sender clause for query", () => {
    expect(buildSearchCondition({ query: "invoice" })).toBe(
      'whose (subject contains "invoice" or sender contains "invoice")'
    );
  });

  it("maps `from` to a sender substring match", () => {
    expect(buildSearchCondition({ from: "bob@example.com" })).toBe(
      'whose sender contains "bob@example.com"'
    );
  });

  it("maps `subject` to a subject substring match", () => {
    expect(buildSearchCondition({ subject: "Q3 report" })).toBe(
      'whose subject contains "Q3 report"'
    );
  });

  // Regression: isRead:false / isFlagged:false must NOT be dropped. `typeof === "boolean"`
  // guards against the falsy-value bug that a plain `if (isRead)` would reintroduce.
  it("includes read status for both true and false", () => {
    expect(buildSearchCondition({ isRead: true })).toBe("whose read status is true");
    expect(buildSearchCondition({ isRead: false })).toBe("whose read status is false");
  });

  it("includes flagged status for both true and false", () => {
    expect(buildSearchCondition({ isFlagged: true })).toBe("whose flagged status is true");
    expect(buildSearchCondition({ isFlagged: false })).toBe("whose flagged status is false");
  });

  // The whole point of the parentheses: when query is ANDed with other filters,
  // the OR must stay grouped or precedence flips the meaning.
  it("preserves OR grouping when combined with AND filters", () => {
    expect(buildSearchCondition({ query: "x", from: "y@z.com", isRead: false })).toBe(
      'whose (subject contains "x" or sender contains "x") and sender contains "y@z.com" and read status is false'
    );
  });

  it("joins all filters with `and` in a stable order", () => {
    expect(
      buildSearchCondition({
        query: "q",
        from: "f",
        subject: "s",
        isRead: true,
        isFlagged: false,
      })
    ).toBe(
      'whose (subject contains "q" or sender contains "q") and sender contains "f" and subject contains "s" and read status is true and flagged status is false'
    );
  });

  it("escapes embedded quotes and backslashes in interpolated values", () => {
    expect(buildSearchCondition({ from: 'a"b' })).toBe('whose sender contains "a\\"b"');
    expect(buildSearchCondition({ subject: "a\\b" })).toBe('whose subject contains "a\\\\b"');
  });
});
