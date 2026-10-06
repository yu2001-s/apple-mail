import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImapClientLike, ImapConfig } from "@/services/imapClient.js";
import { persistentImap } from "@/worker/session.js";

const cfg = {
  host: "imap.example.com",
  port: 993,
  secure: true,
  user: "u",
  pass: "p",
} as ImapConfig;

function fakeClient() {
  const events = new EventEmitter();
  const client = {
    usable: true,
    logout: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    noop: vi.fn(async () => undefined),
    on: (event: string, listener: () => void) => events.on(event, listener),
    emit: (event: string) => events.emit(event),
  };
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("persistent IMAP connection", () => {
  it("reuses one login across operations and hides logout from callers", async () => {
    const client = fakeClient();
    const connect = vi.fn(async () => client as unknown as ImapClientLike);
    const imap = persistentImap(60_000, connect);

    const first = await imap.connect(cfg);
    await first.logout();
    first.close?.();
    await first.noop();
    await imap.connect(cfg);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.logout).not.toHaveBeenCalled();
    expect(client.noop).toHaveBeenCalledTimes(1);
    await imap.close();
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  it("logs out after the idle window and reconnects on the next call", async () => {
    vi.useFakeTimers();
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(
      async () => clients[connect.mock.calls.length - 1] as unknown as ImapClientLike
    );
    const imap = persistentImap(1000, connect);

    await imap.connect(cfg);
    await vi.advanceTimersByTimeAsync(999);
    expect(imap.isOpen()).toBe(true);
    await imap.connect(cfg); // activity restarts the idle window
    await vi.advanceTimersByTimeAsync(999);
    expect(clients[0].logout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clients[0].logout).toHaveBeenCalledTimes(1);
    expect(imap.isOpen()).toBe(false);

    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(2);
    await imap.close();
  });

  it("replaces a connection that dropped or became unusable", async () => {
    const clients = [fakeClient(), fakeClient(), fakeClient()];
    const connect = vi.fn(
      async () => clients[connect.mock.calls.length - 1] as unknown as ImapClientLike
    );
    const imap = persistentImap(60_000, connect);

    await imap.connect(cfg);
    clients[0].emit("close");
    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(2);

    clients[1].usable = false;
    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(3);
    // The dead socket is released rather than left holding the object in memory.
    expect(clients[1].close).toHaveBeenCalled();
    await imap.close();
  });

  it("does not cache a failed login", async () => {
    const client = fakeClient();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("AUTHENTICATIONFAILED"))
      .mockResolvedValueOnce(client);
    const imap = persistentImap(60_000, connect);

    await expect(imap.connect(cfg)).rejects.toThrow("AUTHENTICATIONFAILED");
    expect(imap.isOpen()).toBe(false);
    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(2);
    await imap.close();
  });
});
