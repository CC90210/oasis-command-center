/**
 * One browser-side crash report: the contract between the reporter that runs
 * in the page (lib/client-errors/report.ts) and POST /api/client-errors.
 *
 * Why it exists (2026-10-01): a crash inside a client component shows
 * "Something went wrong" with NO error code, and the console line app/error.tsx
 * wrote ran in the visitor's browser, never on the Worker. The pipeline failed
 * for a user on every other click and the server logged nothing. A report is
 * now sent to the server, where it is logged and kept.
 *
 * Pure (no DOM, no server imports), so the page, the route and the tests share
 * one definition of what a report may carry.
 */

export const CLIENT_ERROR_ENDPOINT = "/api/client-errors";

export const CLIENT_ERROR_KINDS = ["boundary", "global", "window", "rejection"] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** Character limits per field; the route enforces them again. */
export const CLIENT_ERROR_LIMITS = {
  name: 80,
  message: 500,
  stack: 2_000,
  stackLines: 15,
  digest: 64,
  path: 200,
} as const;

/** Hard cap on one request body, checked before it is buffered. */
export const CLIENT_ERROR_MAX_BODY_BYTES = 4_000;

export type ClientErrorReport = {
  kind: ClientErrorKind;
  name: string | null;
  message: string;
  stack: string | null;
  digest: string | null;
  path: string;
};

const ALLOWED_KEYS = new Set(["kind", "name", "message", "stack", "digest", "path"]);
const DIGEST_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Replace control characters (except tab and, when allowed, newline) with a
 * space, so a report cannot forge extra log lines or terminal escapes.
 * Written as a code-point loop rather than a regex range on purpose: the
 * Worker bundle must stay one-byte (tests/worker-source-one-byte.test.ts).
 */
export function stripControl(input: string, keepNewlines: boolean): string {
  let out = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const isControl = code < 32 || code === 127;
    if (!isControl || code === 9 || (keepNewlines && code === 10)) {
      out += ch;
    } else {
      out += " ";
    }
  }
  return out;
}

function clamp(input: string, max: number): string {
  return input.length > max ? input.slice(0, max) : input;
}

/**
 * The pathname only. A query string or hash can carry search text, filter
 * values or a one-time token, so neither is ever kept.
 */
export function pathnameOnly(raw: string): string {
  let path = raw;
  const cut = Math.min(
    path.indexOf("?") === -1 ? path.length : path.indexOf("?"),
    path.indexOf("#") === -1 ? path.length : path.indexOf("#"),
  );
  path = path.slice(0, cut);
  if (!path.startsWith("/")) return "/";
  return clamp(stripControl(path, false), CLIENT_ERROR_LIMITS.path);
}

/** The first lines of a stack, clamped; null when there is none. */
export function clampStack(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const lines = stripControl(raw, true).split("\n").slice(0, CLIENT_ERROR_LIMITS.stackLines);
  return clamp(lines.join("\n"), CLIENT_ERROR_LIMITS.stack);
}

/** One-line message, clamped. */
export function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return clamp(stripControl(raw, false).trim(), CLIENT_ERROR_LIMITS.message);
}

export type ParsedClientError = { ok: true; report: ClientErrorReport } | { ok: false; error: string };

/** Validate an untrusted request body. Unknown keys are refused, not ignored. */
export function parseClientErrorReport(body: unknown): ParsedClientError {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "not_an_object" };
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, error: "unknown_key" };
  }
  const kind = record.kind;
  if (typeof kind !== "string" || !(CLIENT_ERROR_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "bad_kind" };
  }
  const message = cleanMessage(record.message);
  if (!message) return { ok: false, error: "no_message" };
  if (typeof record.path !== "string") return { ok: false, error: "no_path" };
  const name =
    typeof record.name === "string" && record.name.trim()
      ? clamp(stripControl(record.name, false).trim(), CLIENT_ERROR_LIMITS.name)
      : null;
  const digest =
    typeof record.digest === "string" && DIGEST_RE.test(record.digest) ? record.digest : null;
  return {
    ok: true,
    report: {
      kind: kind as ClientErrorKind,
      name,
      message,
      stack: clampStack(record.stack),
      digest,
      path: pathnameOnly(record.path),
    },
  };
}

/**
 * Errors a page throws when a deploy replaced the code it was built against:
 * a chunk or module it asks for no longer exists. A full reload fixes these;
 * "Try again" cannot, because it re-renders with the same stale code.
 */
export function isStaleBuildError(error: { name?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;
  const message = typeof error.message === "string" ? error.message : "";
  return (
    // Chunk ids are numbers or route paths ("app/pipeline/page").
    /Loading chunk [\w/.\[\]-]+ failed/i.test(message) ||
    /Loading CSS chunk [\w/.\[\]-]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  );
}

/**
 * Browser noise that says nothing about our code: a cross-origin script error
 * carries no detail at all, and the ResizeObserver loop notice is benign.
 */
export function isNoiseMessage(message: string): boolean {
  return message === "Script error." || message.startsWith("ResizeObserver loop");
}
