import { describe, expect, it, vi } from "vitest";
import { runSchedulerCli, runSchedulerLoop } from "@/schedulerCli.js";

describe("scheduled-send worker CLI", () => {
  it("exits cleanly when nothing is due", () => {
    const out: string[] = [];
    const code = runSchedulerCli([], {
      manager: { runDueSends: () => [] },
      stdout: (line) => out.push(line),
    });
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });

  it("reports processed results and returns nonzero for a failed job", () => {
    const out: string[] = [];
    const code = runSchedulerCli([], {
      manager: {
        runDueSends: () => [
          {
            scheduleId: "apple-schedule:00000000-0000-4000-8000-000000000001",
            status: "failed",
            error: "Draft changed",
          },
        ],
      },
      stdout: (line) => out.push(line),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/Draft changed/);
  });

  it("prints help without running the worker", () => {
    const runDueSends = vi.fn(() => []);
    const out: string[] = [];
    expect(
      runSchedulerCli(["--help"], {
        manager: { runDueSends },
        stdout: (line) => out.push(line),
      })
    ).toBe(0);
    expect(runDueSends).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/scheduled-send worker/);
  });

  it("keeps polling only while active jobs exist", async () => {
    const runDueSends = vi.fn(() => []);
    const delays = [250, null];
    const nextWorkerDelayMs = vi.fn(() => delays.shift() ?? null);
    const sleep = vi.fn(async () => undefined);

    expect(
      await runSchedulerLoop({
        manager: { runDueSends, nextWorkerDelayMs },
        sleep,
      })
    ).toBe(0);
    expect(runDueSends).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });
});
