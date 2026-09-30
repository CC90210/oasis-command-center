/**
 * Request plumbing for /api/playbook/*: who is asking, is a write same-origin,
 * and the one answer for "not yours to see".
 *
 * 404, never 403: a teammate asking for a founders-only document, or a member
 * of another workspace asking for anything, gets the same answer as a slug
 * that does not exist, so the response confirms nothing (the F0 rule).
 */

import "server-only";
import { NextResponse } from "next/server";
import { resolveDocsViewer, type DocsViewer } from "./viewer";

export function notFoundJson(): NextResponse {
  return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
}

export function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** The reader, or the response to send instead (404 for no access, 503 when the session could not be read). */
export async function requireDocsViewer(): Promise<{ ok: true; viewer: DocsViewer } | { ok: false; response: NextResponse }> {
  try {
    const v = await resolveDocsViewer();
    if (!v.ok) return { ok: false, response: notFoundJson() };
    return { ok: true, viewer: v };
  } catch (err) {
    console.error("[playbook.http.viewer]", err);
    return { ok: false, response: json({ ok: false, error: "session_unavailable", message: "We could not confirm who you are just now. Try again." }, 503) };
  }
}

/**
 * CSRF defence for cookie-authenticated writes: the Origin (or, failing that,
 * the Referer) must name this host. Missing or unparseable headers fail closed.
 */
export function sameOrigin(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return false;
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (!source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

export function crossOrigin(): NextResponse {
  return json({ ok: false, error: "cross_origin_refused" }, 403);
}

/** A JSON object body under `maxBytes`, or undefined. */
export async function readJsonObject(req: Request, maxBytes = 512_000): Promise<Record<string, unknown> | undefined> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  const text = await req.text();
  if (text.length > maxBytes) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const STORAGE_NOT_READY =
  "Document storage is not set up yet (migration bravo__194 has not been applied), so nothing can be saved. Live documents still open.";
