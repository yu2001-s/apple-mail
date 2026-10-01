import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";
import { ImapFlow } from "@/services/imapFlow.js";

describe("ImapFlow reader wakeups", () => {
  it("drains again when data becomes readable while a drain is finishing", async () => {
    const streamer = new EventEmitter();
    const queue: string[] = ["capability"];
    const handled: string[] = [];
    let drains = 0;
    const internals = {
      streamer,
      log: { error: () => undefined },
      id: "test",
      reading: false,
      async reader() {
        drains += 1;
        let item: string | undefined;
        while ((item = queue.shift())) handled.push(item);
        // The tagged OK lands after the last read but before the drain ends:
        // the window in which the stock handler drops the wakeup.
        if (drains === 1) {
          queue.push("tagged-ok");
          streamer.emit("readable");
        }
      },
    };
    ImapFlow.prototype.setEventHandlers.call(internals as unknown as ImapFlow);

    streamer.emit("readable");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toEqual(["capability", "tagged-ok"]);
    expect(drains).toBe(2);
    expect(internals.reading).toBe(false);
  });
});
