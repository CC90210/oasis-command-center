/**
 * lib/meet/answers.ts - the one shape every Oasis Meet answer takes: JSON that is never cached, and a refusal as
 * { ok: false, error }. The access checks (./access.ts) and the routes (./handlers.ts) both answer through here,
 * so a refusal reads the same whichever of them made it.
 */
import { NextResponse } from "next/server";

export function meetJson(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** A refusal. `extra` carries what the page needs to word it (an ended room's reason, say), never storage detail. */
export function meetError(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return meetJson({ ok: false, error, ...extra }, status);
}
