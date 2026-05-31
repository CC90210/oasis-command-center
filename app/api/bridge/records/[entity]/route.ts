/**
 * /api/bridge/records/[entity] — daemon callback channel for entity
 * mutations. The closed-loop endpoint that VPS-hosted Python daemons
 * POST/PATCH to in order to update tenant_records without carrying
 * the dashboard's Supabase service-role key on a foreign machine.
 *
 * Architectural context (2026-05-16):
 *   When SunBiz (or any future client) gets deployed onto their own
 *   VPS, the agent daemons running there (lender_response_classifier,
 *   sequence_runner, inbox monitors, etc.) need to write updates back
 *   to the central dashboard's tenant_records. Today's daemons run on
 *   CC's machine with full Supabase service-role access via .env.agents;
 *   that pattern doesn't scale to a multi-VPS client model where each
 *   tenant's daemon has only its own per-tenant credentials.
 *
 *   This endpoint is the answer. Auth is the same bridge bearer token
 *   that /api/bridge/ping uses — hashed-and-stored in bridge_pairings,
 *   minted per-tenant during onboarding. The token's bridge_pairing
 *   row carries the tenant_id, so daemons can't write across tenants
 *   even if they tried (request body's tenant_id is ignored).
 *
 * Verbs:
 *   POST   /api/bridge/records/[entity]              body: { data: {...} }
 *     → createRecord with entity_type + data. Emits the same
 *       BRAVO_RECORD_STATUS_CHANGED status-change events as
 *       dashboard-driven creates, so drips fire identically whether
 *       the lead was added by an operator click or a daemon callback.
 *
 *   PATCH  /api/bridge/records/[entity]?id=<uuid>    body: { patch: {...} }
 *     → updateRecord; tenant-scope-checked before merge. Same
 *       event emission as the dashboard path.
 *
 * Response shape:
 *   { ok, record: TenantRecord }   on success
 *   { ok: false, error: string }   with a descriptive status code
 *
 * Rate limiting: IP-keyed token-bucket gate (lib/rate-limit) runs
 * BEFORE the bridge-token check so brute-forcers can't probe hash
 * comparison timing. Writes get 30 capacity + 0.5/sec refill — well
 * above legit daemon cadence but tight enough to make a flood loud.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, sha256 } from "@/lib/api-helpers";
import { createRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { rateLimit } from "@/lib/rate-limit";

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip") || "unknown";
}

/** Token-bucket gate — applied BEFORE the bridge token check so
 *  brute-forcers can't probe the hash-comparison timing. Writes get
 *  a tighter ceiling than reads because a misbehaving daemon could
 *  flood the records table; legit daemons fire mutations at known
 *  cadences well under this rate. */
function checkRateLimit(req: NextRequest): NextResponse | null {
  const ip = clientIp(req);
  const rl = rateLimit({
    key: `bridge.records:${ip}`,
    capacity: 30,
    refillPerSec: 0.5,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", reset_in: rl.resetIn },
      { status: 429 },
    );
  }
  return null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Pairing = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  revoked_at: string | null;
};

/**
 * Validate the bearer token + return the bridge_pairing row. Single
 * choke-point — every verb on this route goes through it. Identical
 * shape to /api/bridge/ping's auth so future refactors can extract
 * a shared helper.
 */
async function resolveBridgePairing(req: NextRequest): Promise<
  | { ok: true; pairing: Pairing }
  | { ok: false; status: number; message: string }
> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, message: "Bearer bridge token required" };
  }
  const tokenPlain = auth.slice(7).trim();
  if (!tokenPlain) {
    return { ok: false, status: 401, message: "empty bridge token" };
  }
  const tokenHash = sha256(tokenPlain);

  const db = getServiceSupabase();
  const r = await db
    .from("bridge_pairings")
    .select("id, tenant_id, user_id, revoked_at")
    .eq("bridge_token_hash", tokenHash)
    .maybeSingle();
  if (r.error || !r.data) {
    return { ok: false, status: 401, message: "unknown bridge token" };
  }
  const p = r.data as Pairing;
  if (p.revoked_at) {
    return { ok: false, status: 403, message: "bridge pairing revoked" };
  }
  return { ok: true, pairing: p };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ entity: string }> },
) {
  const limited = checkRateLimit(req);
  if (limited) return limited;
  const auth = await resolveBridgePairing(req);
  if (!auth.ok) return bad(auth.status, auth.message);
  const { entity } = await ctx.params;

  let body: { data?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.data || typeof body.data !== "object") {
    return NextResponse.json(
      { ok: false, error: "data_object_required" },
      { status: 400 },
    );
  }

  try {
    const record = await createRecord({
      tenant_id: auth.pairing.tenant_id,
      entity,
      data: body.data,
    });
    return NextResponse.json({ ok: true, record });
  } catch (err) {
    const code = err instanceof RecordsError ? err.code : "unknown";
    const status = code === "validation" ? 400 : 500;
    return NextResponse.json(
      { ok: false, error: code, message: err instanceof Error ? err.message : "create_failed" },
      { status },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ entity: string }> },
) {
  const limited = checkRateLimit(req);
  if (limited) return limited;
  const auth = await resolveBridgePairing(req);
  if (!auth.ok) return bad(auth.status, auth.message);
  const { entity } = await ctx.params;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "id_query_param_required" }, { status: 400 });
  }

  let body: { patch?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.patch || typeof body.patch !== "object") {
    return NextResponse.json(
      { ok: false, error: "patch_object_required" },
      { status: 400 },
    );
  }

  try {
    const record = await updateRecord({
      tenant_id: auth.pairing.tenant_id,
      entity,
      id,
      patch: body.patch,
    });
    return NextResponse.json({ ok: true, record });
  } catch (err) {
    const code = err instanceof RecordsError ? err.code : "unknown";
    const status =
      code === "not_found" ? 404
        : code === "validation" ? 400
          : 500;
    return NextResponse.json(
      { ok: false, error: code, message: err instanceof Error ? err.message : "update_failed" },
      { status },
    );
  }
}
