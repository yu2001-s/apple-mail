/**
 * The owner password, which approves every connection and every change to
 * linked accounts, and the lockout shared by every page that asks for it.
 */
import { formActionSources } from "../icloud/redirects.js";

export const MAX_FAILURES = 10;
const FAILURE_WINDOW_S = 60 * 60;

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

function failureKey(): string {
  return `owner-failures:${Math.floor(Date.now() / 1000 / FAILURE_WINDOW_S)}`;
}

export async function failures(kv: KV): Promise<number> {
  return Number((await kv.get(failureKey())) ?? 0);
}

export async function recordFailure(kv: KV): Promise<void> {
  const count = (await failures(kv)) + 1;
  await kv.put(failureKey(), String(count), { expirationTtl: FAILURE_WINDOW_S * 2 });
}

/** Constant-time comparison of the supplied and expected passwords. */
export async function passwordMatches(supplied: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [supplied, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value)))
  );
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Headers for an HTML page; `formAction` lists where its forms may go, after redirects. */
export function withPageHeaders(headers: Headers, formAction: string): Headers {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`
  );
  return headers;
}

/** The form-action sources of the OAuth approval page. */
export function consentFormAction(extra: string[]): string {
  return formActionSources(extra);
}
