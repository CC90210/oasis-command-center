/**
 * lib/os/approvals/session.ts — the session-shaped front door the approvals
 * API routes share.
 *
 * Resolves the viewer exactly the way the department pages do
 * (components/os/department/viewer.ts resolveOsViewer: the rail's own inputs),
 * then hands them to the pure scope builder. The tenant, the decider identity
 * and the departments this viewer may act for ALL come from here; a route
 * never reads any of them from its request body.
 *
 * Holds no policy of its own: rules live in lib/os/approvals/rules.ts.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { resolveOsViewer } from "@/components/os/department/viewer";
import { approvalScopeFromViewer } from "@/lib/os/approvals/scope";
import type { ApprovalScope, ApprovalStatus } from "@/lib/os/approvals/rules";

export type ApprovalSession =
  | { ok: true; scope: ApprovalScope; email: string | null; tenantSlug: string | null; db: Client }
  | { ok: false; response: NextResponse };

export async function resolveApprovalSession(): Promise<ApprovalSession> {
  const viewer = await resolveOsViewer();
  if (!viewer.ok) {
    return viewer.reason === "signed_out"
      ? { ok: false, response: approvalError(401, "not_signed_in") }
      : // The workspace slug could not be read. Guessing would treat an OASIS
        // owner as a stranger; say so instead.
        { ok: false, response: approvalError(503, "workspace_unresolved") };
  }
  // The approvals tables live only in Turso.
  if (!tursoConfigured()) return { ok: false, response: approvalError(503, "database_not_configured") };
  return {
    ok: true,
    scope: approvalScopeFromViewer({ surface: viewer.surface, navInput: viewer.navInput }),
    email: viewer.email,
    tenantSlug: viewer.surface.tenantSlug,
    db: getTursoClient(),
  };
}

const MESSAGES: Record<string, string> = {
  not_signed_in: "Sign in to see approvals.",
  workspace_unresolved: "We could not confirm which workspace you are in. Refresh to try again.",
  database_not_configured: "The database is not configured on this deployment.",
  not_found: "Not found.",
  forbidden: "You can see this approval but you cannot decide it.",
  not_pending: "Someone already decided this approval.",
  expired: "This approval expired before anyone decided it.",
  payload_mismatch: "This draft changed since you opened it. Reload to see the current version before approving.",
  payload_hash_required: "Approving needs the version you were shown (payload_hash).",
  note_required: "Say what should change: a note is required to send this back.",
  note_too_long: "The note is too long.",
  comment_required: "Write a comment first.",
  comment_too_long: "The comment is too long.",
  invalid_json: "The request body is not valid JSON.",
  body_invalid: "The request body must be a JSON object.",
  department_invalid: "That is not a department.",
  view_invalid: "view must be pending, decided or all.",
};

/** JSON error with a stable code and a sentence. Never an empty body. */
export function approvalError(
  status: number,
  error: string,
  extra?: { field?: string; status?: ApprovalStatus },
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error,
      message: MESSAGES[error] ?? "The request could not be completed.",
      ...(extra?.field ? { field: extra.field } : {}),
      ...(extra?.status ? { approval_status: extra.status } : {}),
    },
    { status },
  );
}

/** A store refusal as an HTTP answer. */
export function decisionError(r: { error: string; field?: string; status?: ApprovalStatus }): NextResponse {
  switch (r.error) {
    case "not_found":
      return approvalError(404, r.error);
    case "forbidden":
      return approvalError(403, r.error);
    case "not_pending":
    case "expired":
    case "payload_mismatch":
      return approvalError(409, r.error, r);
    default:
      return approvalError(400, r.error, r);
  }
}

/**
 * Log the cause, answer with a sentence. The driver's text stays in the log:
 * "no such table: approvals" is not the viewer's to read.
 */
export function approvalServerError(label: string, err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[approvals:${label}]`, err instanceof Error ? err.stack ?? message : message);
  return NextResponse.json(
    { ok: false, error: "server_error", message: `Something went wrong (${label}). The error has been logged.` },
    { status: 500 },
  );
}

/** Parse a JSON object body without letting a malformed one become an uncaught 500. */
export async function readJsonObject(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "body_invalid" };
  return { ok: true, body: parsed as Record<string, unknown> };
}
