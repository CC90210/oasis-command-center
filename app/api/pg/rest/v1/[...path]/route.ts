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
 *   GET    <table>?col=eq.X&col=in.(a,b)&col=gte.X&select=...&order=...&limit=N
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
import { consume_texttorrent_rate_token, patch_tenant_record_data } from "@/lib/turso-rpc-shim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RpcFn = (client: ReturnType<typeof getTursoClient>,
              args: Record<string, unknown>) => Promise<unknown>;

const RPCS: Record<string, RpcFn> = {
  ...TEXTTORRENT_RPCS,
  consume_texttorrent_rate_token,
  // TWO REGISTRIES EXISTED AND THEY DID NOT MATCH.
  //
  // lib/turso-rpc-shim.ts ports patch_tenant_record_data for the WEB APP, which
  // calls it in-process. This bridge is what EXTERNAL callers reach, and it had
  // its own much smaller list — so every JARVIS call came back with
  // `501 rpc "patch_tenant_record_data" has no Turso port`.
  //
  // Measured 2026-08-20: the TPS phone-lookup worker looked a merchant up, found
  // a mobile (type Wireless), and then could not write it onto the lead — it
  // stamped `manual_review` and dropped the number. A pipeline that finds phones
  // and cannot keep them is indistinguishable from one that finds nothing, and
  // it was the last blocker between 1,099 landline-only leads and being
  // textable.
  //
  // ONLY THIS ONE IS ADDED, deliberately. Spreading the whole shim here would
  // expose 14 RPCs, 12 of them writes and all marked ported-unverified, to
  // anyone holding a bridge token — a privilege change disguised as a
  // convenience. This one is also strictly SAFER than the alternative a caller
  // would otherwise use: it is a compare-and-set merge, where a
  // read-modify-write over the same row through the PATCH endpoint would race
  // and lose updates.
  patch_tenant_record_data,
};

function bad(status: number, message: string) {
  // PostgREST error shape, so the caller's existing handling still works.
  return NextResponse.json({ message, code: String(status) }, { status });
}

/**
 * Tables no bridge caller may touch, whatever credential it presents.
 *
 * Found 2026-08-09 while auditing the Turso cutover for data leakage: a single
 * bearer token reached EVERY table in bravo-empire. Postgres had RLS; SQLite
 * has none, so behind this route there is no per-row boundary at all and the
 * only thing standing between a leaked token and the whole database was the
 * token itself. Measured at the time: 15 tenant_integration_credentials, 17
 * user_integration_credentials, 59 _supabase_auth_users, 3,406 lead_documents,
 * and bridge_pairings — the table holding the hashes of these very tokens.
 *
 * This is a data plane for SMS and lead work. Nothing legitimate on it reads
 * OAuth tokens, auth users, or its own credential store, so denying them costs
 * no caller anything and turns one leaked bearer from "the entire estate" into
 * "the operational tables".
 *
 * A denylist rather than a per-credential allowlist deliberately: the caller
 * this route was built for lives outside this repo, and an allowlist would have
 * silently broken it. Narrowing further to per-credential allowlists is the
 * right next step, once every caller is known.
 */
const FORBIDDEN_TABLES = new Set([
  // Auth + identity
  "_supabase_auth_users",
  "_supabase_auth_identities",
  "_auth_tokens",
  "signing_otp_codes",
  // Credential stores — reading these is lateral movement, not data access
  "tenant_integration_credentials",
  "user_integration_credentials",
  "bridge_pairings",
  "bridge_pair_codes",

  // Round 2, 2026-08-10. The list above was written by guessing at table NAMES,
  // which catches the obvious ones and misses anything named unhelpfully. A
  // scan of every COLUMN in all 173 tables (scripts/turso_sensitivity_scan.mjs
  // in JARVIS) found nine more tables holding token, secret or key material and
  // still served by this route. Names are a convention; columns are what is
  // actually stored.
  //
  // All nine were checked for live callers first — zero JARVIS services and no
  // TextTorrent runtime table among them — so denying them breaks nobody.
  "agent_model_config",            // encrypted_api_key
  "tenant_invites",                // token_hash
  "esign_signers",                 // token_sha256
  "n8n_webhook_secrets",           // secret_hash
  "channel_accounts",              // credential_ref
  "contracts",                     // sign_token
  "application_signing_requests",  // token_sha256
  "cold_sending_mailboxes",        // app_password_enc
  "personalized_form_links",       // token

  // DELIBERATELY NOT DENIED: merchant_background_checks. It carries ein_last4
  // and ssn_last4, but those are tokenised at ingest (last4 + salted hash, never
  // the full number) and the LIVE apex-bg-check worker reads and writes this
  // table through this route. Denying it would break a running production
  // service to hide data that is already truncated. Revisit if that worker moves
  // to a direct connection.
]);

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

/**
 * Range and inequality operators added 2026-08-09 for the APEX/JARVIS fleet.
 *
 * The bridge previously accepted only eq/is/in and 501'd on everything else.
 * That refusal is the right default and it did its job — it rejected APEX's
 * cursor read loudly instead of quietly returning the wrong rows. But a
 * cursor-based reader fundamentally needs `created_at=gte.<cursor>`, and
 * without it the agent coordination channel cannot page at all.
 *
 * These are not new capabilities: lib/turso-postgrest.ts already implements
 * every one of them. Only this route's parser was narrower than the adapter
 * behind it, so this widens the parser to match rather than adding surface.
 */
type FilterOp = "eq" | "in" | "is" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike";
type Filter = { col: string; op: FilterOp; value: string | string[] };

/** Operators that take a single scalar and map 1:1 onto the adapter. */
const SCALAR_OPS = new Set<FilterOp>(["eq", "is", "neq", "gt", "gte", "lt", "lte"]);

/**
 * Pattern operators. Separate from SCALAR_OPS because their operand is ALWAYS a
 * string and must not go through coerce(): a pattern of `true` is the four
 * characters t-r-u-e, not a boolean, and coercing it would silently change the
 * query.
 *
 * lib/turso-postgrest.ts already implements both, including PostgREST's `*`
 * wildcard -> SQL `%` translation. Only this parser was narrower than the
 * adapter behind it.
 *
 * WHAT THIS COST (2026-08-12): `like` was the ONE operator the parser did not
 * accept, so every caller using it got a 501. scripts/drip-watchdog.mjs filters
 * `agent_source=like.sequence:*` — it had been erroring for 32 days
 * (lastSuccessfulWork 2026-07-11) and nothing noticed, because the watchdog
 * recorded its own error as "checked_nothing_to_do". The thing that watches for
 * duplicate merchant sends and volume spikes was itself dark the whole time.
 */
const PATTERN_OPS = new Set<FilterOp>(["like", "ilike"]);

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

    if (SCALAR_OPS.has(op as FilterOp) || PATTERN_OPS.has(op as FilterOp)) {
      filters.push({ col: key, op: op as FilterOp, value: val });
      continue;
    }
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
    if (f.op === "in") {
      q = q.in(f.col, (f.value as string[]).map(coerce));
      continue;
    }
    // Dispatch by name rather than an if-chain, so adding an operator to
    // SCALAR_OPS cannot silently fall through to the wrong comparison — the
    // previous shape ended in a bare `else q.in(...)`, which would have turned
    // any newly-accepted operator into an IN against a string.
    const fn = (q as Record<string, unknown>)[f.op];
    if (typeof fn !== "function") {
      throw new Error(`adapter has no "${f.op}" filter`);
    }
    // Pattern operands stay verbatim. coerce() would turn a pattern of `true`
    // into a boolean and `null` into null, quietly changing what was asked for;
    // a LIKE operand is a string by definition.
    const operand = PATTERN_OPS.has(f.op)
      ? (f.value as string)
      : coerce(f.value as string);
    q = (fn as (c: string, v: unknown) => unknown).call(q, f.col, operand);
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
  if (FORBIDDEN_TABLES.has(table.toLowerCase())) {
    // 404, not 403: this endpoint should not confirm which tables exist.
    return bad(404, "unknown path");
  }

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
