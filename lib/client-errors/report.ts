/**
 * The page side of crash reporting (contract: lib/client-errors/shape.ts).
 *
 * app/error.tsx and app/global-error.tsx call reportClientError for every
 * error a boundary catches, and components/ClientErrorReporter.tsx does the
 * same for uncaught errors and rejected promises. Delivery is a beacon, so a
 * report survives the page reloading or closing; a failed send is dropped,
 * never shown to the person using the page.
 *
 * The core is a factory with an injected sender and clock, so the dedupe and
 * cap rules are tested without a browser.
 */

import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_ERROR_MAX_BODY_BYTES,
  cleanMessage,
  clampStack,
  isNoiseMessage,
  pathnameOnly,
  utf8Bytes,
  type ClientErrorKind,
} from "./shape";

/** At most this many reports leave one page load, whatever happens. */
export const MAX_REPORTS_PER_PAGE_LOAD = 10;
/** The same error on the same page is sent once per this window. */
export const REPORT_DEDUPE_MS = 60_000;

type Sender = (body: string) => void;

function describe(error: unknown): { name: string | null; message: string; stack: string | null; digest: string | null } {
  if (error instanceof Error) {
    const digest = (error as Error & { digest?: unknown }).digest;
    return {
      name: error.name || null,
      message: cleanMessage(error.message),
      stack: clampStack(error.stack),
      digest: typeof digest === "string" ? digest : null,
    };
  }
  if (typeof error === "string") return { name: null, message: cleanMessage(error), stack: null, digest: null };
  try {
    return { name: null, message: cleanMessage(JSON.stringify(error)), stack: null, digest: null };
  } catch {
    return { name: null, message: cleanMessage(String(error)), stack: null, digest: null };
  }
}

export function createClientErrorReporter(send: Sender, now: () => number = Date.now) {
  const lastSent = new Map<string, number>();
  let sent = 0;
  return function report(kind: ClientErrorKind, error: unknown, rawPath: string): boolean {
    if (sent >= MAX_REPORTS_PER_PAGE_LOAD) return false;
    const described = describe(error);
    if (!described.message || isNoiseMessage(described.message)) return false;
    const path = pathnameOnly(rawPath);
    const key = `${kind}|${described.name ?? ""}|${described.message}|${path}`;
    const at = now();
    const previous = lastSent.get(key);
    if (previous !== undefined && at - previous < REPORT_DEDUPE_MS) return false;
    lastSent.set(key, at);
    sent += 1;
    // The route caps the body in UTF-8 BYTES; a stack in a non-Latin script can
    // be under the cap in characters and over it in bytes.
    let body = JSON.stringify({ kind, ...described, path });
    if (utf8Bytes(body) > CLIENT_ERROR_MAX_BODY_BYTES) {
      body = JSON.stringify({ kind, ...described, stack: null, path });
    }
    if (utf8Bytes(body) > CLIENT_ERROR_MAX_BODY_BYTES) return false; // never send what the route will refuse
    send(body);
    return true;
  };
}

function beaconSend(body: string): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(CLIENT_ERROR_ENDPOINT, body)) return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    void fetch(CLIENT_ERROR_ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "content-type": "application/json" },
    }).catch(() => {});
  } catch {
    // dropped: a report must never break the page
  }
}

let pageReporter: ReturnType<typeof createClientErrorReporter> | null = null;

/** Report one error from the current page. Safe to call anywhere; never throws. */
export function reportClientError(kind: ClientErrorKind, error: unknown): void {
  try {
    if (typeof window === "undefined") return;
    pageReporter ??= createClientErrorReporter(beaconSend);
    pageReporter(kind, error, window.location.pathname);
  } catch {
    // never let reporting fail the page
  }
}

/** One stale-build reload per page per this window, so a real loop cannot form. */
export const STALE_RELOAD_WINDOW_MS = 60_000;
const STALE_RELOAD_KEY = "oasis.staleBuildReload";

type ReloadDeps = {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  path: string;
  reload: () => void;
  now?: () => number;
};

/**
 * Reload the page once when it is running code from an older deploy. Returns
 * whether it reloaded. Remembers the reload per path in sessionStorage; when
 * storage is unavailable it does not reload (no guard means no loop protection).
 */
export function reloadOnceForStaleBuild({ storage, path, reload, now = Date.now }: ReloadDeps): boolean {
  if (!storage) return false;
  const key = `${STALE_RELOAD_KEY}:${pathnameOnly(path)}`;
  try {
    const previous = Number(storage.getItem(key) ?? "");
    const at = now();
    if (Number.isFinite(previous) && previous > 0 && at - previous < STALE_RELOAD_WINDOW_MS) return false;
    storage.setItem(key, String(at));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** The browser binding of reloadOnceForStaleBuild. */
export function recoverFromStaleBuild(): boolean {
  if (typeof window === "undefined") return false;
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return reloadOnceForStaleBuild({
    storage,
    path: window.location.pathname,
    reload: () => window.location.reload(),
  });
}
