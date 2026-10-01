/**
 * POST /api/client-errors - a browser-side crash, reported by the page.
 *
 * A crash inside a client component shows "Something went wrong" with no error
 * code and never reached the Worker: the console line app/error.tsx wrote ran
 * in the visitor's browser. On 2026-10-01 the pipeline failed for a user on
 * every other click while the server logged nothing. The page now sends a
 * report here (lib/client-errors/report.ts); this route logs one
 * `[client.error]` line, which `wrangler tail` shows, and keeps a SIGNED-IN
 * report in client_error_reports (migration bravo__198) for the times nobody
 * is tailing. An anonymous report is logged only (lib/client-errors/ingest.ts).
 *
 * Untrusted input, the same rules as /api/perf/vitals:
 *   - same-origin gate FIRST, fail-closed (403) before the body is read;
 *   - a hard byte cap enforced while reading, a strict schema, unknown keys
 *     refused, control characters stripped, pathname only (no query string);
 *   - a per-instance rate cap and a per-address cap so a misbehaving page or a
 *     script forging Origin cannot flood the logs; only signed-in reports are
 *     stored, so an unauthenticated caller cannot fill the table at all.
 * The tenant and the user come from the session, never from the payload; a
 * signed-out page (login, a public form) reports anonymously.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { storeClientErrorReport } from "@/lib/client-errors/ingest";
import { CLIENT_ERROR_MAX_BODY_BYTES, parseClientErrorReport } from "@/lib/client-errors/shape";

export const dynamic = "force-dynamic";

const RATE_CAP_PER_MIN = 120;
/** One address may send at most this many reports a minute (per instance). */
const PER_ADDRESS_CAP_PER_MIN = 20;
// Retention (30 days) runs on a schedule: lib/client-errors/retention.ts via
// /api/cron/connection-health, so old rows go even when no new report arrives.

let windowStart = 0;
let windowCount = 0;
const perAddress = new Map<string, number>();

function overRateCap(address: string | null): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
    perAddress.clear();
  }
  windowCount++;
  if (windowCount > RATE_CAP_PER_MIN) return true;
  if (!address) return false;
  const seen = (perAddress.get(address) ?? 0) + 1;
  perAddress.set(address, seen);
  return seen > PER_ADDRESS_CAP_PER_MIN;
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

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOrigin(req)) return NextResponse.json({ ok: false }, { status: 403 });
  // Cloudflare sets cf-connecting-ip to the caller's address on every request.
  if (overRateCap(req.headers.get("cf-connecting-ip"))) return new NextResponse(null, { status: 204 });

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

  // A signed-in report becomes a row; an anonymous one stays a log line only
  // (lib/client-errors/ingest.ts). Before migration bravo__198 the log line is
  // the whole record, by design.
  try {
    await storeClientErrorReport(report, { tenantId, userId, userAgent });
  } catch (err) {
    console.error("[client.error.store]", err instanceof Error ? err.message : String(err));
  }
  return new NextResponse(null, { status: 204 });
}
