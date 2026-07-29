/**
 * Persistent, confirmation-gated scheduled sending for saved Apple Mail drafts.
 *
 * Mail.app exposes Send Later in its UI, but not in its public AppleScript
 * dictionary. This manager therefore stores verified draft schedules locally
 * and relies on a user LaunchAgent to run a small due-send worker. The worker
 * re-reads the draft immediately before sending and refuses to send if any
 * reviewed field changed.
 *
 * The state machine intentionally favors at-most-once behavior: a job is
 * durably marked `sending` before Mail is asked to send. If the worker crashes
 * in that narrow window, the job becomes `needs_review` and is never retried
 * automatically, avoiding an accidental duplicate.
 */
import { randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { HybridDraftManager } from "@/services/hybridDraftManager.js";
import type { Draft } from "@/types.js";

export type ScheduledSendStatus =
  "pending" | "sending" | "sent" | "failed" | "cancelled" | "needs_review";

export interface ScheduledDraftSnapshot {
  draftId: string;
  fingerprint: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId?: string;
}

export interface ScheduledSend {
  scheduleId: string;
  draftId: string;
  status: ScheduledSendStatus;
  /** Canonical UTC instant. */
  sendAt: string;
  /** Original RFC 3339 string, retained so the requested offset is visible. */
  requestedSendAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  sentAt?: string;
  cancelledAt?: string;
  error?: string;
  snapshot: ScheduledDraftSnapshot;
}

interface ScheduledSendStore {
  version: 1;
  jobs: Record<string, ScheduledSend>;
}

export interface ScheduledSendResult {
  success: boolean;
  schedules?: ScheduledSend[];
  schedule?: ScheduledSend;
  error?: string;
}

export interface WorkerResult {
  scheduleId: string;
  status: ScheduledSendStatus;
  error?: string;
}

export interface ScheduledSendManagerOptions {
  registryPath?: string;
  draftManager?: ScheduledDraftOperations;
  now?: () => Date;
  ensureWorker?: () => { success: boolean; error?: string };
  lockStaleMs?: number;
}

export interface ScheduledDraftOperations {
  getDraft(draftId: string): Promise<{ success: boolean; draft?: Draft; error?: string }>;
  sendDraft(
    draftId: string,
    expectedRevision?: string
  ): Promise<{ success: boolean; draft?: Draft; error?: string }>;
}

export interface LaunchAgentOptions {
  nodePath: string;
  workerPath: string;
  homeDir?: string;
  uid?: number;
  spawn?: typeof spawnSync;
}

const LAUNCH_AGENT_LABEL = "io.github.yu2001-s.apple-mail.scheduled-send";
export const SCHEDULE_ID_PATTERN = /^apple-schedule:[0-9a-f-]{36}$/i;
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const MIN_SCHEDULE_LEAD_MS = 30 * 1000;
const STUCK_SENDING_MS = 5 * 60 * 1000;

function scheduleRegistryPathDefault(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "apple-mail-mcp",
    "scheduled-sends.json"
  );
}

function emptyStore(): ScheduledSendStore {
  return { version: 1, jobs: {} };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function parseScheduledInstant(
  value: string,
  now: Date = new Date()
): { success: true; date: Date } | { success: false; error: string } {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/i
  );
  if (!match) {
    return {
      success: false,
      error:
        'send_at must be RFC 3339 with an explicit timezone, for example "2026-07-29T07:00:00+08:00".',
    };
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zone,
    zoneHour,
    zoneMinute,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? "0");
  const daysInMonth =
    month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  const offsetHour = zone.toUpperCase() === "Z" ? 0 : Number(zoneHour);
  const offsetMinute = zone.toUpperCase() === "Z" ? 0 : Number(zoneMinute);
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return { success: false, error: `Invalid send_at value "${value}".` };
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return { success: false, error: `Invalid send_at value "${value}".` };
  }
  const lead = date.getTime() - now.getTime();
  if (lead < MIN_SCHEDULE_LEAD_MS) {
    return { success: false, error: "send_at must be at least 30 seconds in the future." };
  }
  if (lead > MAX_SCHEDULE_AHEAD_MS) {
    return { success: false, error: "send_at cannot be more than 366 days in the future." };
  }
  return { success: true, date };
}

export function buildScheduledSendLaunchAgentPlist(options: LaunchAgentOptions): string {
  const supportDir = join(
    options.homeDir ?? homedir(),
    "Library",
    "Application Support",
    "apple-mail-mcp"
  );
  const stdoutPath = join(supportDir, "scheduled-send.log");
  const stderrPath = join(supportDir, "scheduled-send.error.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(options.nodePath)}</string>
    <string>${xmlEscape(options.workerPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

/** Install or refresh the per-user LaunchAgent used by scheduled sends. */
export function ensureScheduledSendLaunchAgent(options: LaunchAgentOptions): {
  success: boolean;
  error?: string;
} {
  if (!existsSync(options.nodePath)) {
    return { success: false, error: `Node executable not found: ${options.nodePath}` };
  }
  if (!existsSync(options.workerPath)) {
    return { success: false, error: `Scheduled-send worker not found: ${options.workerPath}` };
  }
  const homeDir = options.homeDir ?? homedir();
  const supportDir = join(homeDir, "Library", "Application Support", "apple-mail-mcp");
  const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  mkdirSync(supportDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  const tmp = `${plistPath}.${process.pid}.tmp`;
  writeFileSync(tmp, buildScheduledSendLaunchAgentPlist({ ...options, homeDir }), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, plistPath);

  const spawn = options.spawn ?? spawnSync;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    return { success: false, error: "Could not determine the current macOS user id." };
  }
  const domain = `gui/${uid}`;
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const printed = spawn("launchctl", ["print", service], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (printed.status === 0) {
    const kick = spawn("launchctl", ["kickstart", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return kick.status === 0
      ? { success: true }
      : {
          success: false,
          error: `Could not refresh scheduled-send worker: ${String(kick.stderr ?? "").trim()}`,
        };
  }
  const boot = spawn("launchctl", ["bootstrap", domain, plistPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return boot.status === 0
    ? { success: true }
    : {
        success: false,
        error: `Could not install scheduled-send worker: ${String(boot.stderr ?? "").trim()}`,
      };
}

function snapshotDraft(draft: Draft): ScheduledDraftSnapshot {
  return {
    draftId: draft.draftId,
    fingerprint: draft.revision,
    from: draft.from,
    to: [...draft.to],
    cc: [...draft.cc],
    bcc: [...draft.bcc],
    subject: draft.subject,
    messageId: draft.messageId,
  };
}

export class ScheduledSendManager {
  private readonly registryPath: string;
  private readonly lockPath: string;
  private readonly draftManager: ScheduledDraftOperations;
  private readonly now: () => Date;
  private readonly ensureWorker: () => { success: boolean; error?: string };
  private readonly lockStaleMs: number;

  constructor(options: ScheduledSendManagerOptions = {}) {
    this.registryPath = options.registryPath ?? scheduleRegistryPathDefault();
    this.lockPath = `${this.registryPath}.lock`;
    this.draftManager = options.draftManager ?? new HybridDraftManager();
    this.now = options.now ?? (() => new Date());
    this.ensureWorker = options.ensureWorker ?? (() => ({ success: true }));
    this.lockStaleMs = options.lockStaleMs ?? 2 * 60 * 1000;
  }

  private loadStore(): ScheduledSendStore {
    if (!existsSync(this.registryPath)) return emptyStore();
    try {
      const parsed = JSON.parse(
        readFileSync(this.registryPath, "utf8")
      ) as Partial<ScheduledSendStore>;
      if (parsed.version !== 1 || !parsed.jobs || typeof parsed.jobs !== "object") {
        throw new Error("unsupported or incomplete registry format");
      }
      return parsed as ScheduledSendStore;
    } catch (error) {
      throw new Error(
        `Scheduled-send registry is unreadable; no jobs were changed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private saveStore(store: ScheduledSendStore): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, this.registryPath);
  }

  private withLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    let fd: number;
    try {
      fd = openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      try {
        const age = Date.now() - statSync(this.lockPath).mtimeMs;
        if (age > this.lockStaleMs) {
          unlinkSync(this.lockPath);
          fd = openSync(this.lockPath, "wx", 0o600);
        } else {
          throw new Error("Scheduled-send registry is busy; retry shortly.");
        }
      } catch (inner) {
        if (inner instanceof Error && inner.message.includes("registry is busy")) throw inner;
        throw error;
      }
    }
    try {
      return operation();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(this.lockPath);
      } catch {
        // The lock is advisory. A missing cleanup file is harmless.
      }
    }
  }

  list(status?: ScheduledSendStatus): ScheduledSend[] {
    const jobs = Object.values(this.loadStore().jobs);
    return jobs
      .filter((job) => !status || job.status === status)
      .sort((left, right) => left.sendAt.localeCompare(right.sendAt));
  }

  activeForDraft(draftId: string): ScheduledSend | null {
    return (
      this.list().find(
        (job) => job.draftId === draftId && (job.status === "pending" || job.status === "sending")
      ) ?? null
    );
  }

  async scheduleDrafts(draftIds: string[], sendAt: string): Promise<ScheduledSendResult> {
    const uniqueIds = [...new Set(draftIds)];
    if (uniqueIds.length === 0) {
      return { success: false, error: "At least one draft_id is required." };
    }
    if (uniqueIds.length > 100) {
      return { success: false, error: "Cannot schedule more than 100 drafts at once." };
    }
    const parsed = parseScheduledInstant(sendAt, this.now());
    if (!parsed.success) return parsed;

    const drafts: Draft[] = [];
    for (const draftId of uniqueIds) {
      const found = await this.draftManager.getDraft(draftId);
      if (!found.success || !found.draft) {
        return {
          success: false,
          error: found.error ?? `Draft "${draftId}" was not found.`,
        };
      }
      if (found.draft.hasAttachments && found.draft.backend !== "imap") {
        return {
          success: false,
          error: `Draft "${draftId}" has attachments and cannot be safely scheduled through Mail's scripting bridge.`,
        };
      }
      if (found.draft.to.length + found.draft.cc.length + found.draft.bcc.length === 0) {
        return { success: false, error: `Draft "${draftId}" has no recipients.` };
      }
      drafts.push(found.draft);
    }

    const created = this.withLock((): ScheduledSendResult => {
      const store = this.loadStore();
      for (const draft of drafts) {
        const existing = Object.values(store.jobs).find(
          (job) =>
            job.draftId === draft.draftId && (job.status === "pending" || job.status === "sending")
        );
        if (existing) {
          return {
            success: false,
            error: `Draft "${draft.draftId}" is already scheduled as ${existing.scheduleId}.`,
          };
        }
      }
      const now = this.now().toISOString();
      const schedules = drafts.map((draft): ScheduledSend => {
        const scheduleId = `apple-schedule:${randomUUID()}`;
        const job: ScheduledSend = {
          scheduleId,
          draftId: draft.draftId,
          status: "pending",
          sendAt: parsed.date.toISOString(),
          requestedSendAt: sendAt.trim(),
          createdAt: now,
          updatedAt: now,
          snapshot: snapshotDraft(draft),
        };
        store.jobs[scheduleId] = job;
        return job;
      });
      this.saveStore(store);
      return { success: true, schedules };
    });
    if (!created.success || !created.schedules) return created;

    // Persist jobs before starting the worker so RunAtLoad cannot race, observe
    // an empty registry, and exit just before the schedules are written.
    const worker = this.ensureWorker();
    if (!worker.success) {
      const createdIds = new Set(created.schedules.map((job) => job.scheduleId));
      this.withLock(() => {
        const store = this.loadStore();
        for (const scheduleId of createdIds) delete store.jobs[scheduleId];
        this.saveStore(store);
      });
      return {
        success: false,
        error: worker.error ?? "Could not install the scheduled-send worker.",
      };
    }
    return created;
  }

  cancel(scheduleId: string): ScheduledSendResult {
    return this.withLock(() => {
      const store = this.loadStore();
      const job = store.jobs[scheduleId];
      if (!job) return { success: false, error: `Schedule "${scheduleId}" was not found.` };
      if (job.status !== "pending") {
        return {
          success: false,
          error: `Schedule "${scheduleId}" is ${job.status} and can no longer be cancelled.`,
        };
      }
      const now = this.now().toISOString();
      job.status = "cancelled";
      job.cancelledAt = now;
      job.updatedAt = now;
      this.saveStore(store);
      return { success: true, schedule: job };
    });
  }

  reschedule(scheduleId: string, sendAt: string): ScheduledSendResult {
    const parsed = parseScheduledInstant(sendAt, this.now());
    if (!parsed.success) return parsed;
    let previous: { sendAt: string; requestedSendAt: string } | null = null;
    const changed = this.withLock((): ScheduledSendResult => {
      const store = this.loadStore();
      const job = store.jobs[scheduleId];
      if (!job) return { success: false, error: `Schedule "${scheduleId}" was not found.` };
      if (job.status !== "pending") {
        return {
          success: false,
          error: `Schedule "${scheduleId}" is ${job.status} and can no longer be rescheduled.`,
        };
      }
      previous = { sendAt: job.sendAt, requestedSendAt: job.requestedSendAt };
      job.sendAt = parsed.date.toISOString();
      job.requestedSendAt = sendAt.trim();
      job.updatedAt = this.now().toISOString();
      this.saveStore(store);
      return { success: true, schedule: job };
    });
    if (!changed.success || !changed.schedule) return changed;
    const worker = this.ensureWorker();
    if (!worker.success && previous) {
      this.withLock(() => {
        const store = this.loadStore();
        const job = store.jobs[scheduleId];
        if (job?.status === "pending") {
          job.sendAt = previous?.sendAt ?? job.sendAt;
          job.requestedSendAt = previous?.requestedSendAt ?? job.requestedSendAt;
          job.updatedAt = this.now().toISOString();
          this.saveStore(store);
        }
      });
      return {
        success: false,
        error: worker.error ?? "Could not refresh the scheduled-send worker.",
      };
    }
    return changed;
  }

  /**
   * Milliseconds until the worker should check again, or null when no active
   * schedule requires it to stay alive. Capped so cancellation/rescheduling
   * and clock changes are observed promptly.
   */
  nextWorkerDelayMs(maxPollMs = 30_000): number | null {
    const now = this.now().getTime();
    const waits = this.list()
      .filter((job) => job.status === "pending" || job.status === "sending")
      .map((job) => {
        if (job.status === "pending") return new Date(job.sendAt).getTime() - now;
        const started = job.startedAt ? new Date(job.startedAt).getTime() : now;
        return started + STUCK_SENDING_MS - now;
      });
    if (waits.length === 0) return null;
    return Math.min(Math.max(Math.min(...waits), 250), maxPollMs);
  }

  private markResult(
    scheduleId: string,
    status: "sent" | "failed",
    error?: string
  ): ScheduledSend | null {
    return this.withLock(() => {
      const store = this.loadStore();
      const job = store.jobs[scheduleId];
      if (!job || job.status !== "sending") return null;
      const now = this.now().toISOString();
      job.status = status;
      job.updatedAt = now;
      if (status === "sent") job.sentAt = now;
      if (error) job.error = error;
      this.saveStore(store);
      return job;
    });
  }

  private claimDue(): ScheduledSend | null {
    return this.withLock(() => {
      const store = this.loadStore();
      const now = this.now();
      let changed = false;
      for (const job of Object.values(store.jobs)) {
        if (
          job.status === "sending" &&
          job.startedAt &&
          now.getTime() - new Date(job.startedAt).getTime() >= STUCK_SENDING_MS
        ) {
          job.status = "needs_review";
          job.error =
            "Worker stopped after marking this job as sending. It was not retried to avoid a duplicate.";
          job.updatedAt = now.toISOString();
          changed = true;
        }
      }
      const due = Object.values(store.jobs)
        .filter(
          (job) => job.status === "pending" && new Date(job.sendAt).getTime() <= now.getTime()
        )
        .sort((left, right) => left.sendAt.localeCompare(right.sendAt))[0];
      if (!due) {
        if (changed) this.saveStore(store);
        return null;
      }
      due.status = "sending";
      due.startedAt = now.toISOString();
      due.updatedAt = now.toISOString();
      this.saveStore(store);
      return JSON.parse(JSON.stringify(due)) as ScheduledSend;
    });
  }

  async runDueSends(): Promise<WorkerResult[]> {
    const results: WorkerResult[] = [];
    while (true) {
      const job = this.claimDue();
      if (!job) break;
      const current = await this.draftManager.getDraft(job.draftId);
      if (!current.success || !current.draft) {
        const error = current.error ?? "Scheduled draft was not found.";
        this.markResult(job.scheduleId, "failed", error);
        results.push({ scheduleId: job.scheduleId, status: "failed", error });
        continue;
      }
      if (current.draft.revision !== job.snapshot.fingerprint) {
        const error = "Draft content changed after scheduling; it was not sent.";
        this.markResult(job.scheduleId, "failed", error);
        results.push({ scheduleId: job.scheduleId, status: "failed", error });
        continue;
      }
      const sent = await this.draftManager.sendDraft(job.draftId, job.snapshot.fingerprint);
      if (!sent.success) {
        const error = sent.error ?? "Mail.app failed to send the scheduled draft.";
        this.markResult(job.scheduleId, "failed", error);
        results.push({ scheduleId: job.scheduleId, status: "failed", error });
        continue;
      }
      this.markResult(job.scheduleId, "sent");
      results.push({ scheduleId: job.scheduleId, status: "sent" });
    }
    return results;
  }
}
