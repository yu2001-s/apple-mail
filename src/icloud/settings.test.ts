import { describe, expect, it } from "vitest";
import {
  addressesIn,
  applyDisplayName,
  applySettingsUpdate,
  applySignature,
  displayNameFor,
  formatSender,
  kvSettingsStore,
  mergeDiscovered,
  parseSettings,
  seedSettings,
  type Settings,
} from "@/icloud/settings.js";

const env = {
  APPLE_MAIL_MCP_SMTP_USER: "me@icloud.com",
  APPLE_MAIL_MCP_SMTP_FROM: "me@icloud.com",
  APPLE_MAIL_MCP_SMTP_ALLOWED_FROM: "hello@example.org, Peter@example.org",
};

function base(): Settings {
  return seedSettings(env, {
    primaryAddress: "peter@example.org",
    signatures: { "me@icloud.com": "Me" },
  });
}

describe("connector settings", () => {
  it("seeds from the account configuration and keeps the configured primary", () => {
    expect(base()).toEqual({
      version: 1,
      primaryAddress: "Peter@example.org",
      addresses: ["me@icloud.com", "hello@example.org", "Peter@example.org"],
      signatures: { "me@icloud.com": "Me" },
      excluded: [],
    });
    expect(seedSettings(env).primaryAddress).toBe("me@icloud.com");
    expect(() => seedSettings({})).toThrow(/No sending address/);
  });

  it("changes the primary and the sender list, and refuses unsafe changes", () => {
    const next = applySettingsUpdate(base(), {
      primaryAddress: "hello@example.org",
      addAddresses: ["new@example.org"],
      removeAddresses: ["PETER@example.org"],
    });
    expect(next.primaryAddress).toBe("hello@example.org");
    expect(next.addresses).toEqual(["me@icloud.com", "hello@example.org", "new@example.org"]);
    expect(next.excluded).toEqual(["PETER@example.org"]);
    // Re-adding clears the exclusion.
    expect(applySettingsUpdate(next, { addAddresses: ["peter@example.org"] }).excluded).toEqual([]);

    expect(() => applySettingsUpdate(base(), { removeAddresses: ["peter@example.org"] })).toThrow(
      /primary address/
    );
    expect(() => applySettingsUpdate(base(), { primaryAddress: "other@example.org" })).toThrow(
      /add it first/
    );
    expect(() => applySettingsUpdate(base(), { addAddresses: ["not an address"] })).toThrow(
      /valid email/
    );
    expect(() =>
      applySettingsUpdate(base(), { addAddresses: ["a@b.co"], removeAddresses: ["A@b.co"] })
    ).toThrow(/both added and removed/);
  });

  it("sets and clears signatures for sending addresses only", () => {
    const signed = applySignature(base(), "PETER@example.org", "Peter\r\nPoieti\n\n");
    expect(signed.signatures).toEqual({
      "me@icloud.com": "Me",
      "Peter@example.org": "Peter\nPoieti",
    });
    expect(applySignature(signed, "peter@example.org", "  ").signatures).toEqual({
      "me@icloud.com": "Me",
    });
    expect(() => applySignature(base(), "stranger@example.org", "x")).toThrow(/not a sending/);
  });

  it("trusts Sent senders, only suggests inbox recipients, and honours removals", () => {
    const settings = applySettingsUpdate(base(), { removeAddresses: ["hello@example.org"] });
    const now = new Date("2026-10-02T00:00:00Z");
    const result = mergeDiscovered(
      settings,
      ["alias@example.org", "hello@example.org", "me@icloud.com"],
      ["sales@example.org", "friend@icloud.com", "someone@elsewhere.com", "hello@example.org"],
      now
    );
    expect(result.added).toEqual(["alias@example.org"]);
    expect(result.settings.addresses).toContain("alias@example.org");
    expect(result.settings.addresses).not.toContain("hello@example.org");
    // Only custom domains already used for sending; shared iCloud domains never.
    expect(result.suggested).toEqual(["sales@example.org"]);
    expect(result.settings.discoveredAt).toBe(now.toISOString());
  });

  it("extracts addresses from header values", () => {
    expect(
      addressesIn('"Su, Doctor" <a@example.org>, b@example.org, =?UTF-8?B?5L2g?= <c@x.co>')
    ).toEqual(["a@example.org", "b@example.org", "c@x.co"]);
  });

  it("rejects stored settings that would leave no valid primary", () => {
    expect(() => parseSettings({ version: 1, primaryAddress: "a@b.co", addresses: [] })).toThrow();
    expect(() => parseSettings(null)).toThrow();
  });

  it("persists to KV", async () => {
    const data = new Map<string, string>();
    const kv = kvSettingsStore({
      get: async (key) => data.get(key) ?? null,
      put: async (key, value) => void data.set(key, value),
    });
    expect(await kv.load()).toBeNull();
    await kv.save(base());
    expect(await kv.load()).toEqual(base());
  });
});

describe("display names", () => {
  const base = {
    version: 1 as const,
    primaryAddress: "peter@poieti.com",
    addresses: ["peter@poieti.com", "hello@draftfold.com"],
    signatures: {},
    excluded: [],
  };

  it("uses a default name for every address, with per-address overrides", () => {
    let settings = applyDisplayName(base, "  Shao Yu   Huang ");
    expect(formatSender(settings, "peter@poieti.com")).toBe('"Shao Yu Huang" <peter@poieti.com>');
    settings = applyDisplayName(settings, "Draftfold", "HELLO@draftfold.com");
    expect(formatSender(settings, "hello@draftfold.com")).toBe('"Draftfold" <hello@draftfold.com>');
    expect(displayNameFor(settings, "peter@poieti.com")).toBe("Shao Yu Huang");
    settings = applyDisplayName(settings, "", "hello@draftfold.com");
    expect(displayNameFor(settings, "hello@draftfold.com")).toBe("Shao Yu Huang");
    settings = applyDisplayName(settings, "");
    expect(formatSender(settings, "peter@poieti.com")).toBe("peter@poieti.com");
  });

  it("rejects unsafe names and unknown addresses, and survives storage", () => {
    expect(() => applyDisplayName(base, 'Evil" <x@y.z>')).toThrow(/display name/);
    expect(() => applyDisplayName(base, "Name", "nobody@x.com")).toThrow(/not a sending address/);
    const stored = parseSettings(
      JSON.parse(
        JSON.stringify(
          applyDisplayName(applyDisplayName(base, "Shao"), "Hi", "hello@draftfold.com")
        )
      )
    );
    expect(stored.displayName).toBe("Shao");
    expect(stored.displayNames).toEqual({ "hello@draftfold.com": "Hi" });
  });
});
