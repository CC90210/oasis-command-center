/**
 * POST /api/bridge/ping — local bridge daemon heartbeat + integrations report.
 *
 * Called every 60s by `oasis bridge start` running through the installed launcher.
 * Authenticated with the bearer token issued at /api/auth/pair.
 *
 * Body:
 *   {
 *     services: {
 *       [service_slug: string]: {
 *         status: "healthy" | "degraded" | "down" | "unconfigured",
 *         metadata?: { version?: string, path?: string, ... },
 *         last_error?: string
 *       }
 *     },
 *     // Phase F of giggly-reef — bridge advertises which local tools its
 *     // installation has registered. Dashboard reads this when filtering
 *     // TOOL_DEFINITIONS so it doesn't tell the model about read_file when
 *     // the operator's bridge version doesn't ship that tool yet.
 *     tool_capabilities?: string[]
 *   }
 *
 * Auth (O3a): resolvePairingFromBearer (lib/bridge/pairing-auth.ts), the one
 * bearer check ping, poll and records share. A reused, already-rotated
 * token is refused and revokes the computer. The pairing's owner, if it has
 * one, must still be a LIVE seat (lib/os/seat.ts liveSeat) — a deactivated
 * member's still-valid token no longer heartbeats.
 *
 * Effect:
 *   - Bumps bridge_pairings.last_seen_at + last_seen_ip for the active token.
 *   - Stamps bridge_pairings.claim_protocols when the body names any — its
 *     OWN column, never folded into tool_capabilities (O3a).
 *   - Stamps bridge_pairings.tool_capabilities when present in the body, but
 *     NEVER for a 'connector'-scope pairing: that column feeds the operator
 *     chat's bridge tool palette, and a connector computer (Settings >
 *     Computers, no shell) must never be able to widen it.
 *   - Upserts each service into integrations_health for the resolved tenant.
 *     A report that only says a key NAME is on the computer (metadata.via
 *     "env_key_present" / "local_install", lib/integrations/presence-heartbeat.ts)
 *     never replaces a REAL result on the same row: OASIS's own email sender
 *     writes its Gmail sign-in outcome to the "gws" row, and this minute-by-
 *     minute scan used to reset it to healthy and clear its error (PR #553
 *     review W5). The scan still creates a row, and refreshes its own. Any
 *     key-name report takes that guarded write, whatever status it carries.
 *   - Marks every row it writes as a computer's report (metadata._reported_by,
 *     lib/integrations/presence-heartbeat.ts BRIDGE_REPORT_KEY), so no paired
 *     computer can post a result that reads as OASIS's own email sender's
 *     (PR #558 review).
 *
 * Returns: { ok, pairing_id, services_recorded, real_results_kept, tool_capabilities_recorded }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { bad, getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";
import { liveSeat } from "@/lib/os/seat";
import { CLI_INVENTORY_SERVICE, buildCliMachinePatch, type CliMachinePatch } from "@/lib/bridge-cli-status";
import {
  BRIDGE_REPORT_KEY,
  BRIDGE_REPORT_VALUE,
  PRESENCE_ONLY_VIA,
  isPresenceOnlyHeartbeat,
} from "@/lib/integrations/presence-heartbeat";
import { parseRuntimeClaimState } from "@/lib/bridge/runtime-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ServiceReport = {
  status?: "healthy" | "degraded" | "down" | "unconfigured";
  metadata?: Record<string, unknown>;
  last_error?: string;
};

export async function POST(req: NextRequest) {
  // Brute-force backstop BEFORE the token check so a guesser hammering
  // bridge_tokens can't time hash lookups. Legit bridges hit at most
  // 1 ping per 60s; the bucket allows generous bursts (paired clients
  // sometimes retry after a network blip) but caps sustained rate.
  const callerIp = getClientIp(req);
  const rl = rateLimit({
    key: `bridge.ping:${callerIp}`,
    capacity: 60,
    refillPerSec: 1,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", reset_in: rl.resetIn },
      { status: 429 },
    );
  }
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const pairing = resolved.pairing;

  const db = getServiceSupabase();

  // A pairing with a recorded owner must still be a LIVE seat — a
  // deactivated member's token stops heartbeating at once, not when it is
  // separately revoked (O3a security rule 6).
  if (pairing.userId) {
    const seat = await liveSeat(pairing.tenantId, pairing.userId);
    if (!seat.live) return bad(403, `seat_inactive: ${seat.reason}`);
  }

  // Resolve profile_id (integrations_health is keyed on profile_id, service)
  let profileId: string | null = null;
  if (pairing.userId) {
    const pf = await db
      .from("user_profiles")
      .select("id")
      .eq("auth_user_id", pairing.userId)
      .eq("tenant_id", pairing.tenantId)
      .maybeSingle();
    profileId = pf.data?.id || null;
  }
  if (!profileId) {
    // integrations_health is profile-scoped. Accepting a heartbeat without a
    // resolvable profile makes the tenant look online while the signed-in
    // user's CLI inventory can never be read. Fail closed instead of
    // stamping a false-success marker on the daemon.
    return NextResponse.json(
      { ok: false, error: "bridge_profile_unresolved" },
      { status: 409 },
    );
  }

  let body: {
    services?: Record<string, ServiceReport>;
    tool_capabilities?: string[];
    claim_protocols?: string[];
    runtime_state?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return bad(400, "body must be JSON");
  }

  // Touch the pairing's heartbeat. If the bridge included a tool_capabilities
  // list, stamp it on the pairing too — dashboard reads this when filtering
  // TOOL_DEFINITIONS for the /api/chat tool palette. NEVER for a
  // 'connector'-scope pairing (Settings > Computers, no shell): that column
  // feeds the operator chat's bridge tool list, and a connector must never
  // be able to widen it (O3a).
  const recordedIp = getClientIp(req);
  const pairingUpdate: Record<string, unknown> = {
    last_seen_at: new Date().toISOString(),
    last_seen_ip: recordedIp === "unknown" ? null : recordedIp,
  };
  let toolCapsRecorded = false;
  if (Array.isArray(body.tool_capabilities) && pairing.scope !== "connector") {
    // Defensive — refuse anything that isn't a list of plain strings.
    const cleaned = body.tool_capabilities
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .map((t) => t.toLowerCase());
    pairingUpdate.tool_capabilities = cleaned;
    toolCapsRecorded = true;
  }
  // claim_protocols lives in its own column — never merged into
  // tool_capabilities, and recorded for every scope (a connector computer
  // still needs to tell the server which claim protocols it speaks).
  if (Array.isArray(body.claim_protocols)) {
    const allowedProtocols = new Set(["department_task_v1", "department_task_v2", "runtime_action_v1", "coding_harness_task_v1"]);
    const cleanedProtocols = body.claim_protocols.filter((t): t is string => typeof t === "string" && allowedProtocols.has(t));
    pairingUpdate.claim_protocols = JSON.stringify(cleanedProtocols);
  }
  const runtimeState = parseRuntimeClaimState(body.runtime_state);
  if (!runtimeState.ok) return bad(400, runtimeState.code);
  if (runtimeState.state) pairingUpdate.claim_runtime_state = JSON.stringify(runtimeState.state);
  const pairingWrite = await db
    .from("bridge_pairings")
    .update(pairingUpdate)
    .eq("tenant_id", pairing.tenantId)
    .eq("id", pairing.pairingId)
    .is("revoked_at", null);
  if (pairingWrite.error) {
    console.error("[bridge.ping.pairing]", pairingWrite.error.message);
    return bad(503, "pairing_heartbeat_persist_failed");
  }

  // Upsert per-service health rows, tenant-scoped
  const tenantId = pairing.tenantId;
  const services = body.services || {};
  let recorded = 0;
  let realResultsKept = 0;
  let cliInventoryPersistFailed = false;
  for (const [service, report] of Object.entries(services)) {
    if (!service) continue;
    const status = (report.status || "unconfigured") as
      | "healthy" | "degraded" | "down" | "unconfigured";
    const reported = report.metadata && typeof report.metadata === "object" && !Array.isArray(report.metadata) ? report.metadata : {};
    const payload: Record<string, unknown> = {
      tenant_id: tenantId,
      profile_id: profileId,
      service,
      status,
      last_ping_at: new Date().toISOString(),
      last_error: report.last_error || null,
      // Every row a computer reports is marked as its report (set last, so a
      // computer cannot send it away): it is never read as the check of a value
      // OASIS keeps on its server (lib/integrations/presence-heartbeat.ts).
      metadata: { ...reported, [BRIDGE_REPORT_KEY]: BRIDGE_REPORT_VALUE },
    };
    // The CLI inventory is per computer: this pairing writes ONLY its own entry
    // (recordCliMachine), so two paired computers never replace each other.
    if (service === CLI_INVENTORY_SERVICE) {
      const patch = buildCliMachinePatch(
        pairing.pairingId,
        pairing.label,
        reported,
        payload.last_ping_at as string,
      );
      // No providers object (or an unusable pairing id) writes nothing and is
      // reported as a failed persist, never as a success.
      if (patch && (await recordCliMachine(payload, patch))) recorded += 1;
      else cliInventoryPersistFailed = true;
      continue;
    }
    // Any key-name report, whatever status it carries, takes the guarded write:
    // an older bridge's "unconfigured" scan must not erase a real result either.
    if (isPresenceOnlyHeartbeat(payload.metadata)) {
      const written = await recordPresence(payload);
      if (written === null) {
        if (service === CLI_INVENTORY_SERVICE) cliInventoryPersistFailed = true;
      } else if (written) {
        recorded += 1;
      } else {
        realResultsKept += 1;
      }
      continue;
    }
    const r = await db
      .from("integrations_health")
      .upsert(payload, { onConflict: "profile_id,service" });
    if (!r.error) {
      recorded += 1;
    } else if (service === CLI_INVENTORY_SERVICE) {
      cliInventoryPersistFailed = true;
    }
  }

  if (cliInventoryPersistFailed) {
    return NextResponse.json(
      {
        ok: false,
        error: "cli_inventory_persist_failed",
        services_recorded: recorded,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    pairing_id: pairing.pairingId,
    services_recorded: recorded,
    real_results_kept: realResultsKept,
    tool_capabilities_recorded: toolCapsRecorded,
    runtime_state_recorded: runtimeState.state !== null,
  });
}

/**
 * A key-name report, written only where it cannot erase a real result: it
 * creates the row, or refreshes a row that is itself a key-name report or
 * holds no result ("unconfigured"). A row a real check wrote (a status of
 * healthy, degraded or down with no key-name marker) is left as it is, in the
 * same statement, so a check landing between a read and a write cannot be lost.
 * True: written. False: a real result was kept. Null: the write failed (logged).
 */
async function recordPresence(payload: Record<string, unknown>): Promise<boolean | null> {
  const via = PRESENCE_ONLY_VIA.map(() => "?").join(", ");
  try {
    const r = await getTursoClient().execute({
      sql: `INSERT INTO integrations_health (tenant_id, profile_id, service, status, last_ping_at, last_error, metadata, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT (profile_id, service) DO UPDATE SET
              tenant_id = excluded.tenant_id, status = excluded.status, last_ping_at = excluded.last_ping_at,
              last_error = NULL, metadata = excluded.metadata, updated_at = excluded.updated_at
            WHERE COALESCE(integrations_health.status, '') NOT IN ('healthy', 'degraded', 'down')
               OR (json_valid(integrations_health.metadata)
                   AND json_extract(integrations_health.metadata, '$.via') IN (${via}))`,
      args: [
        payload.tenant_id as string,
        payload.profile_id as string,
        payload.service as string,
        payload.status as string,
        payload.last_ping_at as string,
        JSON.stringify(payload.metadata ?? {}),
        payload.last_ping_at as string,
        ...PRESENCE_ONLY_VIA,
      ],
    });
    return r.rowsAffected > 0;
  } catch (error) {
    console.error("[bridge.ping.presence]", { service: payload.service, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * One computer's CLI inventory, merged into the shared local_ai_clis row in ONE
 * statement: json_set touches only metadata.machines.<this pairing>, so a
 * heartbeat landing between another computer's read and write cannot erase it
 * (a read-modify-write here would). The top-level providers/checked_at of a row
 * written before per-computer reports are removed so nothing reads them as a
 * computer. True: written. False: the write failed (logged).
 */
async function recordCliMachine(payload: Record<string, unknown>, patch: CliMachinePatch): Promise<boolean> {
  const reported = (payload.metadata ?? {}) as Record<string, unknown>;
  const { providers: _providers, checked_at: _checkedAt, ...rest } = reported;
  const fresh = { ...rest, machines: { [patch.id]: patch.entry } };
  try {
    await getTursoClient().execute({
      sql: `INSERT INTO integrations_health (tenant_id, profile_id, service, status, last_ping_at, last_error, metadata, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (profile_id, service) DO UPDATE SET
              tenant_id = excluded.tenant_id, status = excluded.status, last_ping_at = excluded.last_ping_at,
              last_error = excluded.last_error, updated_at = excluded.updated_at,
              metadata = json_remove(
                json_set(
                  CASE WHEN json_valid(integrations_health.metadata) AND json_type(integrations_health.metadata) = 'object'
                       THEN integrations_health.metadata ELSE '{}' END,
                  ?, json(?), '$._reported_by', ?),
                '$.providers', '$.checked_at')`,
      args: [
        payload.tenant_id as string,
        payload.profile_id as string,
        payload.service as string,
        payload.status as string,
        payload.last_ping_at as string,
        (payload.last_error as string | null) ?? null,
        JSON.stringify(fresh),
        payload.last_ping_at as string,
        patch.path,
        JSON.stringify(patch.entry),
        BRIDGE_REPORT_VALUE,
      ],
    });
    return true;
  } catch (error) {
    console.error("[bridge.ping.cli_machine]", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
