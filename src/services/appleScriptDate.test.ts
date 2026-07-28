import { describe, it, expect } from "vitest";
import { buildAppleScriptDate } from "@/services/appleMailManager.js";

describe("buildAppleScriptDate", () => {
  // Regression for issue #15: the comparison date must be built from numeric
  // components, never coerced from a locale-formatted string like
  // `date "May 30, 2026"`, which throws on non-English system locales and
  // silently zeroes out date-filtered searches.
  it('never emits locale-dependent `date "..."` string coercion', () => {
    const script = buildAppleScriptDate("_dateFrom", new Date(2026, 4, 30));
    expect(script).not.toMatch(/date\s+"/);
  });

  it("assigns each component numerically with a 1-based month", () => {
    const script = buildAppleScriptDate("_dateFrom", new Date(2026, 4, 30, 9, 15, 45));
    expect(script).toContain("set _dateFrom to current date");
    expect(script).toContain("set year of _dateFrom to 2026");
    expect(script).toContain("set month of _dateFrom to 5"); // May -> 5, not 4
    expect(script).toContain("set day of _dateFrom to 30");
    expect(script).toContain("set hours of _dateFrom to 9");
    expect(script).toContain("set minutes of _dateFrom to 15");
    expect(script).toContain("set seconds of _dateFrom to 45");
  });

  it("resets day to 1 before setting month/year to avoid month overflow", () => {
    const script = buildAppleScriptDate("_d", new Date(2026, 1, 28));
    const firstDayReset = script.indexOf("set day of _d to 1");
    const monthAssign = script.indexOf("set month of _d to 2");
    expect(firstDayReset).toBeGreaterThanOrEqual(0);
    expect(monthAssign).toBeGreaterThan(firstDayReset);
  });
});
