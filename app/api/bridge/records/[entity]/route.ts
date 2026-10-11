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
 *   This endpoint is the answer. Auth is resolvePairingFromBearer
 *   (lib/bridge/pairing-auth.ts), the same bridge bearer token
 *   /api/bridge/ping uses — hashed-and-stored in bridge_pairings,
 *   minted per-tenant during onboarding. The token's bridge_pairing
 *   row carries the tenant_id, so daemons can't write across tenants
 *   even if they tried (request body's tenant_id is ignored).
 *
 *   O3a: record writes need a DAEMON-scope pairing — a 'connector'
 *   pairing (Settings > Computers, no shell) is refused outright. When
 *   the pairing has a recorded owner, every call re-checks that owner's
 *   LIVE seat and canWriteCrm (lib/role-gates.ts): a deactivated member's
 *   or a read_only seat's still-valid token stops writing records at
 *   once, not only when its pairing is separately revoked.
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
import { bad, getClientIp } from "@/lib/api-helpers";
import { createRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { rateLimit } from "@/lib/rate-limit";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import { resolvePairingFromBearer, isDaemonScope, type ResolvedPairing } from "@/lib/bridge/pairing-auth";
import { liveSeat } from "@/lib/os/seat";
import { canWriteCrm } from "@/lib/role-gates";

/** Token-bucket gate — applied BEFORE the bridge token check so
 *  brute-forcers can't probe the hash-comparison timing. Writes get
 *  a tighter ceiling than reads because a misbehaving daemon could
 *  flood the records table; legit daemons fire mutations at known
 *  cadences well under this rate. */
function checkRateLimit(req: NextRequest): NextResponse | null {
  const ip = getClientIp(req);
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

async function rejectUnsafeOasisLeadWrite(
  tenantId: string,
  entity: string,
): Promise<NextResponse | null> {
  if (entity !== "lead") return null;
  const tenantSlug = await resolveOwnedSlug(tenantId);
  if (!tenantSlug) {
    return NextResponse.json(
      { ok: false, error: "tenant_scope_unresolved" },
      { status: 503 },
    );
  }
  if (!isWebsiteSalesTenantSlug(tenantSlug)) return null;
  return NextResponse.json(
    {
      ok: false,
      error: "canonical_sales_workflow_required",
      message:
        "Raw bridge writes cannot mutate OASIS leads. Use the claim, import, assignment, or lifecycle workflow so CC/Adon ownership and the active cycle remain intact.",
    },
    { status: 409 },
  );
}

/**
 * Validate the bearer token + return the bridge_pairing row. Single
 * choke-point — every verb on this route goes through it. Shared with
 * /api/bridge/ping and /api/cron-jobs/poll via resolvePairingFromBearer
 * (lib/bridge/pairing-auth.ts), plus the two gates this route adds: daemon
 * scope, and — when the pairing has a recorded owner — a live seat that can
 * still write CRM data (O3a).
 */
async function resolveBridgePairing(req: NextRequest): Promise<
  | { ok: true; pairing: ResolvedPairing }
  | { ok: false; status: number; message: string }
> {
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, message: resolved.error };
  }
  const { pairing } = resolved;
  if (!isDaemonScope(pairing)) {
    return { ok: false, status: 403, message: "connector_scope_cannot_write_records" };
  }
  if (pairing.userId) {
    const seat = await liveSeat(pairing.tenantId, pairing.userId);
    if (!seat.live) {
      return { ok: false, status: 403, message: `seat_inactive: ${seat.reason}` };
    }
    if (!canWriteCrm(seat.profile.teamRole)) {
      return { ok: false, status: 403, message: "role_cannot_write_crm" };
    }
  }
  return { ok: true, pairing };
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
  const unsafeWrite = await rejectUnsafeOasisLeadWrite(auth.pairing.tenantId, entity);
  if (unsafeWrite) return unsafeWrite;

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
      tenant_id: auth.pairing.tenantId,
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
  const unsafeWrite = await rejectUnsafeOasisLeadWrite(auth.pairing.tenantId, entity);
  if (unsafeWrite) return unsafeWrite;

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
      tenant_id: auth.pairing.tenantId,
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
