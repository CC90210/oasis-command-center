/**
 * Shared request plumbing for /api/calendar/*: who is asking, is the write
 * same-origin, and how a store error becomes an HTTP answer.
 */

import "server-only";
import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { CalendarStoreError, type Owner } from "./store";

export type OwnerResult = { ok: true; owner: Owner } | { ok: false; response: NextResponse };

export async function requireOwner(): Promise<OwnerResult> {
  const session = await resolveSessionContext();
  if (!session.ok)
    return { ok: false, response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  return { ok: true, owner: { tenantId: session.tenantId, userId: session.userId } };
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

export function forbidden(): NextResponse {
  return NextResponse.json({ ok: false, error: "cross_origin_refused" }, { status: 403 });
}

/** Parses a JSON body under a size cap. Undefined means "refuse it". */
export async function readJson(req: Request, maxBytes = 256_000): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  const text = await req.text();
  if (text.length > maxBytes) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

export function errorResponse(err: unknown, where: string): NextResponse {
  if (err instanceof CalendarStoreError) {
    if (err.status >= 500) console.error(`[calendar.${where}]`, err.message);
    return NextResponse.json({ ok: false, error: err.code, detail: err.message }, { status: err.status });
  }
  console.error(`[calendar.${where}]`, err);
  return NextResponse.json({ ok: false, error: "calendar_unavailable" }, { status: 500 });
}
