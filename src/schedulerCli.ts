#!/usr/bin/env node
/**
 * launchd entrypoint for Apple Mail scheduled sends.
 *
 * This worker is intentionally tiny: claim due jobs, verify the reviewed draft
 * fingerprint, ask Mail.app to send, and persist the terminal result. It never
 * retries a job that had already entered the `sending` state.
 */
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { ScheduledSendManager } from "@/services/scheduledSendManager.js";
import { loadFileConfig } from "@/services/fileConfig.js";

export interface SchedulerCliDeps {
  manager?: Pick<ScheduledSendManager, "runDueSends"> &
    Partial<Pick<ScheduledSendManager, "nextWorkerDelayMs">>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function runSchedulerCli(argv: string[], deps: SchedulerCliDeps = {}): number {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));
  if (argv.includes("--help")) {
    out("apple-mail scheduled-send worker (normally started by launchd)");
    return 0;
  }
  try {
    loadFileConfig();
    const manager = deps.manager ?? new ScheduledSendManager();
    const results = manager.runDueSends();
    if (results.length > 0) out(JSON.stringify(results));
    return results.some((result) => result.status === "failed") ? 1 : 0;
  } catch (error) {
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

/** Stay alive only while pending/sending jobs exist, polling at most every 30s. */
export async function runSchedulerLoop(deps: SchedulerCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    loadFileConfig();
    const manager = deps.manager ?? new ScheduledSendManager();
    while (true) {
      const results = manager.runDueSends();
      if (results.length > 0) out(JSON.stringify(results));
      const delay = manager.nextWorkerDelayMs?.() ?? null;
      if (delay === null) return 0;
      await sleep(delay);
    }
  } catch (error) {
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    // A controlled registry/permission failure must not trigger launchd's
    // crash-only KeepAlive loop. The error is logged and a later schedule or
    // login can start a fresh worker for review.
    return 0;
  }
}

function isInvokedDirectly(): boolean {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  if (process.argv.slice(2).includes("--help")) {
    process.exit(runSchedulerCli(["--help"]));
  }
  runSchedulerLoop().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(0);
    }
  );
}
