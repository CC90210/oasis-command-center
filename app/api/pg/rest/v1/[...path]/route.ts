/**
 * PostgREST-compatible bridge over Turso, for the TextTorrent runtime.
 *
 * WHY THIS EXISTS. The SunBiz SMS runtime (`jarvis`, deployed as two Docker
 * containers on the VPS) talks to Supabase through a 40-line client that builds
 * every request as `${BRAVO_SUPABASE_URL}/rest/v1/...` with raw PostgREST query
 * syntax. There is no supabase-js in it, so no client shim can intercept it, and
 * the repo belongs to a different workstream.
 *
 * But that base URL is an ENV VAR. Serving the same wire protocol from here lets
 * the runtime move to Turso by changing one variable, with zero source changes
 * on their side.
 *
 * DELIBERATELY NOT A GENERAL POSTGREST. It implements exactly the shapes
 * services/texttorrent-runtime/repository.js actually issues:
 *
 *   GET    <table>?col=eq.X&col=in.(a,b)&select=...&limit=N
 *   POST   <table>                       (insert, Prefer: return=representation)
 *   PATCH  <table>?col=eq.X&col=in.(a,b) (update, Prefer: return=representation)
 *   POST   rpc/<name>                    (dispatched to the ported RPCs)
 *
 * Anything else returns 501 naming the unsupported feature. A bridge that
 * silently ignores a filter it does not understand would return the wrong rows
 * — for a claim query that means two workers processing one SMS. Refusing loudly
 * is the only safe default.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { createTursoPostgrest } from "@/lib/turso-postgrest";
import { TEXTTORRENT_RPCS } from "@/lib/turso-rpc-texttorrent";
import { consume_texttorrent_rate_token } from "@/lib/turso-rpc-shim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RpcFn = (client: ReturnType<typeof getTursoClient>,
              args: Record<string, unknown>) => Promise<unknown>;

const RPCS: Record<string, RpcFn> = {
  ...TEXTTORRENT_RPCS,
  consume_texttorrent_rate_token,
};

function bad(status: number, message: string) {
  // PostgREST error shape, so the caller's existing handling still works.
  return NextResponse.json({ message, code: String(status) }, { status });
}

/**
 * Constant-time bearer check against any accepted bridge secret.
 *
 * Two credentials rather than one, added 2026-08-09 for the APEX/JARVIS fleet.
 * The obvious move was to hand JARVIS the existing TT_PG_BRIDGE_TOKEN, but its
 * value cannot be read back out of Vercel (sensitive type), and rotating it to
 * a value we DO know would silently lock out any holder we cannot see from this
 * repo — there is no client for this route anywhere in the tree, so the caller
 * it was built for lives somewhere else. Issuing a second, independently
 * revocable credential breaks nobody and lets each fleet be cut off on its own.
 *
 * Both are compared; the check still fails closed when neither is configured.
 */
function authorised(req: NextRequest): boolean {
  const accepted = [
    process.env.TT_PG_BRIDGE_TOKEN || "",
    process.env.APEX_PG_BRIDGE_TOKEN || "",
  ].filter(Boolean);
  if (!accepted.length) return false; // fail closed when unconfigured

  const header = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : apikey.trim();
  if (!presented) return false;

  // Hash both sides so timingSafeEqual gets equal-length buffers regardless of
  // the presented value's length (it throws on a length mismatch, which would
  // itself leak length).
  //
  // Every candidate is compared even after a match, so the work done does not
  // depend on WHICH credential was presented — a short-circuit would leak, by
  // timing, which fleet a caller belongs to.
  const a = createHash("sha256").update(presented).digest();
  let ok = false;
  for (const candidate of accepted) {
    const b = createHash("sha256").update(candidate).digest();
    if (timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

type Filter = { col: string; op: "eq" | "in" | "is"; value: string | string[] };

/** Parse PostgREST query params into filters + modifiers, refusing the unknown. */
function parseQuery(sp: URLSearchParams):
  | { ok: true; filters: Filter[]; select: string; limit?: number; order?: string }
  | { ok: false; reason: string } {
  const filters: Filter[] = [];
  let select = "*";
  let limit: number | undefined;
  let order: string | undefined;

  for (const [key, raw] of sp.entries()) {
    if (key === "select") { select = raw || "*"; continue; }
    if (key === "limit") { limit = Number(raw); continue; }
    if (key === "order") { order = raw; continue; }
    if (key === "offset") return { ok: false, reason: "offset" };

    // col=eq.value | col=in.(a,b) | col=is.null
    const dot = raw.indexOf(".");
    if (dot < 0) return { ok: false, reason: `filter syntax on "${key}"` };
    const op = raw.slice(0, dot);
    const val = raw.slice(dot + 1);

    if (op === "eq") { filters.push({ col: key, op: "eq", value: val }); continue; }
    if (op === "is") { filters.push({ col: key, op: "is", value: val }); continue; }
    if (op === "in") {
      const inner = val.replace(/^\(/, "").replace(/\)$/, "");
      const parts = inner.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      filters.push({ col: key, op: "in", value: parts });
      continue;
    }
    return { ok: false, reason: `operator "${op}" on "${key}"` };
  }
  return { ok: true, filters, select, limit, order };
}

/** PostgREST spells booleans "true"/"false" and null as "null" in the URL. */
function coerce(v: string): string | number | boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  return v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(q: any, filters: Filter[]) {
  for (const f of filters) {
    if (f.op === "eq") q = q.eq(f.col, coerce(f.value as string));
    else if (f.op === "is") q = q.is(f.col, coerce(f.value as string));
    else q = q.in(f.col, (f.value as string[]).map(coerce));
  }
  return q;
}

function ready() {
  if (!tursoConfigured()) return bad(503, "Turso is not configured on this deployment");
  return null;
}

async function handle(req: NextRequest, segments: string[], method: "GET" | "POST" | "PATCH") {
  if (!authorised(req)) return bad(401, "invalid bridge credentials");
  const notReady = ready();
  if (notReady) return notReady;

  // rpc/<name>
  if (segments[0] === "rpc") {
    if (method !== "POST") return bad(405, "rpc requires POST");
    const name = segments[1];
    const fn = RPCS[name];
    if (!fn) {
      // Loud, and it names the function — an unported RPC must never look like
      // an empty result.
      return bad(501, `rpc "${name}" has no Turso port`);
    }
    let args: Record<string, unknown> = {};
    try { args = (await req.json()) ?? {}; } catch { args = {}; }
    const data = await fn(getTursoClient(), args);
    return NextResponse.json(data ?? null);
  }

  const table = segments[0];
  if (!table || segments.length > 1) return bad(404, "unknown path");

  const parsed = parseQuery(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return bad(501, `unsupported PostgREST feature: ${parsed.reason}`);
  }

  const db = createTursoPostgrest(getTursoClient());

  if (method === "GET") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db.from(table).select(parsed.select);
    q = applyFilters(q, parsed.filters);
    if (parsed.order) {
      const [col, dir] = parsed.order.split(".");
      q = q.order(col, { ascending: dir !== "desc" });
    }
    if (parsed.limit !== undefined) q = q.limit(parsed.limit);
    const r = await q;
    if (r.error) return bad(400, r.error.message ?? "query failed");
    return NextResponse.json(r.data ?? []);
  }

  const wantsRows = (req.headers.get("prefer") || "").includes("return=representation");
  let body: unknown;
  try { body = await req.json(); } catch { body = undefined; }

  if (method === "POST") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db.from(table).insert(body as never);
    if (wantsRows) q = q.select("*");
    const r = await q;
    if (r.error) return bad(400, r.error.message ?? "insert failed");
    return NextResponse.json(wantsRows ? (r.data ?? []) : null,
      { status: 201 });
  }

  // PATCH
  if (parsed.filters.length === 0) {
    // PostgREST itself refuses an unfiltered UPDATE, and so does this: an
    // accidental table-wide write here would rewrite every lease row.
    return bad(400, "UPDATE requires a filter");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.from(table).update(body as never);
  q = applyFilters(q, parsed.filters);
  if (wantsRows) q = q.select("*");
  const r = await q;
  if (r.error) return bad(400, r.error.message ?? "update failed");
  return NextResponse.json(wantsRows ? (r.data ?? []) : null);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handle(req, path ?? [], "GET");
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handle(req, path ?? [], "POST");
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handle(req, path ?? [], "PATCH");
}
