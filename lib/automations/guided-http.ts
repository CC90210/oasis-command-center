/**
 * lib/automations/guided-http.ts - the shared edges of the guided-automation routes.
 *
 * A Next route module may export only handlers and config, so the parts every route repeats live here:
 * the same-origin check on anything that changes data (the session is a cookie), the session gate, the
 * body read with a size cap, the id shape, and a catch that turns an unexpected throw into one plain
 * sentence and a log line instead of a stack trace in the browser.
 */
import "server-only";

import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/calendar/http";
import { guidedSession, type GuidedSession, type ServiceResult } from "@/lib/automations/guided-service";

export const MAX_BODY_BYTES = 24_000;
const ID_RE = /^[0-9a-fA-F-]{36}$/;

export const isGuidedId = (id: string): boolean => ID_RE.test(id);

async function readBody(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false };
  let text = "";
  try {
    text = await req.text();
  } catch {
    return { ok: false };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false };
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ok: true, body: parsed as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

type Handler<T> = (s: GuidedSession, body: Record<string, unknown>) => Promise<ServiceResult<T>>;

/**
 * Run one route: same-origin for writes, the session gate, the body (writes only), then `run`.
 * `id`, when given, must look like an id before anything is read.
 */
export async function guidedRoute<T>(
  req: Request,
  opts: { write: boolean; id?: string; body?: boolean },
  run: Handler<T>,
): Promise<NextResponse> {
  if (opts.write && !sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden", message: "This request did not come from this site, so nothing was changed." }, { status: 403 });
  }
  if (opts.id !== undefined && !isGuidedId(opts.id)) {
    return NextResponse.json({ ok: false, error: "not_found", message: "We could not find that automation." }, { status: 404 });
  }
  const gate = await guidedSession();
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status, headers: { "cache-control": "no-store" } });
  let body: Record<string, unknown> = {};
  if (opts.body) {
    const read = await readBody(req);
    if (!read.ok) {
      return NextResponse.json({ ok: false, error: "payload_invalid", message: "The request was not readable. Nothing was changed." }, { status: 400 });
    }
    body = read.body;
  }
  try {
    const result = await run(gate.session, body);
    return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[guided.route]", { tenantId: gate.session.tenantId, error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { ok: false, error: "server_error", message: "Something went wrong on our side. Nothing was changed. Try again in a moment." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
