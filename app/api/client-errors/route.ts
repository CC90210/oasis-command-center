/**
 * POST /api/client-errors - a browser-side crash, reported by the page.
 *
 * A crash inside a client component shows "Something went wrong" with no error
 * code and never reached the Worker: the console line app/error.tsx wrote ran
 * in the visitor's browser. On 2026-10-01 the pipeline failed for a user on
 * every other click while the server logged nothing. The page now sends a
 * report here (lib/client-errors/report.ts); this route logs one
 * `[client.error]` line, which `wrangler tail` shows, and keeps the report in
 * client_error_reports (migration bravo__198) for the times nobody is tailing.
 *
 * Untrusted input, the same rules as /api/perf/vitals:
 *   - same-origin gate FIRST, fail-closed (403) before the body is read;
 *   - a hard byte cap enforced while reading, a strict schema, unknown keys
 *     refused, control characters stripped, pathname only (no query string);
 *   - a per-instance rate cap so a misbehaving page cannot flood logs or rows.
 * The tenant and the user come from the session, never from the payload; a
 * signed-out page (login, a public form) reports anonymously.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { CLIENT_ERROR_MAX_BODY_BYTES, parseClientErrorReport } from "@/lib/client-errors/shape";

export const dynamic = "force-dynamic";

const RATE_CAP_PER_MIN = 120;
/** Reports older than this are deleted (data minimisation; they can hold page text). */
const RETENTION_DAYS = 30;
/** Roughly one write in this many also prunes expired rows. */
const PRUNE_EVERY = 50;

let windowStart = 0;
let windowCount = 0;

function overRateCap(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount > RATE_CAP_PER_MIN;
}

function sameOrigin(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  for (const header of ["origin", "referer"]) {
    const value = req.headers.get(header);
    if (!value) continue;
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > CLIENT_ERROR_MAX_BODY_BYTES) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > CLIENT_ERROR_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isMissingTable(message: string): boolean {
  return /no such table/i.test(message);
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOrigin(req)) return NextResponse.json({ ok: false }, { status: 403 });
  if (overRateCap()) return new NextResponse(null, { status: 204 });

  let raw: string | null;
  try {
    raw = await readCapped(req);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (!raw) return NextResponse.json({ ok: false }, { status: 400 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const parsed = parseClientErrorReport(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const report = parsed.report;

  // Who hit it, from the session only. A failed or absent session is an
  // anonymous report, never a reason to drop it.
  let tenantId: string | null = null;
  let userId: string | null = null;
  try {
    const session = await resolveSessionContext();
    if (session.ok) {
      tenantId = session.tenantId;
      userId = session.userId;
    }
  } catch {
    // anonymous
  }

  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;
  console.error(
    `[client.error] ${JSON.stringify({ ...report, tenant_id: tenantId, user_id: userId, user_agent: userAgent })}`,
  );

  try {
    const db = getServiceSupabase();
    const { error } = await db.from("client_error_reports").insert({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      user_id: userId,
      kind: report.kind,
      name: report.name,
      message: report.message,
      stack: report.stack,
      digest: report.digest,
      path: report.path,
      user_agent: userAgent,
    });
    if (error) {
      // Before migration bravo__198 is applied the table does not exist: the
      // log line above is then the whole record, by design.
      if (!isMissingTable(error.message)) console.error("[client.error.store]", error.message);
    } else if (Math.floor(Math.random() * PRUNE_EVERY) === 0) {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
      const pruned = await db.from("client_error_reports").delete().lt("created_at", cutoff);
      if (pruned.error) console.error("[client.error.prune]", pruned.error.message);
    }
  } catch (err) {
    console.error("[client.error.store]", err instanceof Error ? err.message : String(err));
  }
  return new NextResponse(null, { status: 204 });
}
