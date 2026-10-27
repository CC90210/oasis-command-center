/**
 * lib/devices/reconnect.ts - asking one of your own computers to reconnect.
 *
 * CC, 2026-10-27: Refresh in Settings > Devices should connect a computer that
 * has been connected before. The page cannot reach a computer; the computer's
 * bridge checks in every minute (POST /api/bridge/ping). So Refresh records a
 * request for each of the person's offline computers, and the check-in's reply
 * says reconnect: true to the bridge process that was running when the request
 * was made. That bridge (CEO-Agent bravo_cli) exits once it is idle and launchd
 * starts it fresh: current code, its claim loop, and a new pairing by itself if
 * its token was refused.
 *
 * The request names the process it told (the bridge's own started_at), not a
 * time on two clocks: a Mac whose clock runs behind the server's could
 * otherwise be told to reconnect after every restart. A different process
 * checking in means the restart happened, and the request is cleared. A bridge
 * too old to say when it started cannot act on the reply, so it is not told. A
 * request nobody picked up within RECONNECT_EXPIRES_MS (a computer that is off)
 * is dropped rather than restarting it whenever it next wakes.
 *
 * Kept in tenant_integration_credentials (service bridge_reconnect, field = the
 * pairing id): tenant-scoped like every row there, and no migration.
 */
import "server-only";

import {
  BRIDGE_RECONNECT_SERVICE,
  deleteTenantIntegrationValue,
  getTenantIntegrationValue,
  setTenantIntegrationValue,
} from "@/lib/tenant-integration-store";

export const RECONNECT_EXPIRES_MS = 15 * 60_000;

/** One stored request: when Refresh asked, and which bridge process has been told. */
export type ReconnectRequest = { requested_at: string; told: string | null };

/** What to do at a check-in: the reply, and what becomes of the stored request. */
export type ReconnectDecision = { reconnect: boolean; next: ReconnectRequest | null | "keep" };

/** PURE. A stored request, or null when there is none or it cannot be read. */
export function parseReconnectRequest(raw: string | null): ReconnectRequest | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ReconnectRequest>;
    if (typeof v.requested_at !== "string" || !Number.isFinite(Date.parse(v.requested_at))) return null;
    return { requested_at: v.requested_at, told: typeof v.told === "string" ? v.told : null };
  } catch {
    return null;
  }
}

/** PURE. The started_at a bridge sent, when it is a usable process stamp. */
export function processStamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * PURE. A check-in from the process `startedAt` (null: a bridge too old to say)
 * against the stored request, at `nowMs`.
 */
export function reconnectDecision(request: ReconnectRequest | null, startedAt: string | null, nowMs: number): ReconnectDecision {
  if (!request) return { reconnect: false, next: "keep" };
  if (nowMs - Date.parse(request.requested_at) > RECONNECT_EXPIRES_MS) return { reconnect: false, next: null };
  if (!startedAt) return { reconnect: false, next: "keep" };
  if (request.told === null) return { reconnect: true, next: { ...request, told: startedAt } };
  if (request.told === startedAt) return { reconnect: true, next: "keep" };
  return { reconnect: false, next: null };
}

/**
 * PURE. The request Refresh stores, given the one already pending. Clicked
 * again before the computer reconnected, it is renewed for another
 * RECONNECT_EXPIRES_MS but keeps the process it told: starting over would
 * tell the freshly restarted process to restart a second time.
 */
export function renewedRequest(pending: ReconnectRequest | null, nowMs: number): ReconnectRequest {
  const requested_at = new Date(nowMs).toISOString();
  const live = pending !== null && nowMs - Date.parse(pending.requested_at) <= RECONNECT_EXPIRES_MS;
  return { requested_at, told: live ? pending.told : null };
}

/** Refresh: ask this pairing's bridge to reconnect at its next check-in. */
export async function requestReconnect(input: {
  tenantId: string;
  pairingId: string;
  requestedBy: string | null;
}): Promise<{ ok: true; requestedAt: string } | { ok: false; error: string }> {
  let pending: ReconnectRequest | null = null;
  try {
    pending = parseReconnectRequest(await getTenantIntegrationValue(input.tenantId, BRIDGE_RECONNECT_SERVICE, input.pairingId));
  } catch (err) {
    // Unread: asked afresh. The worst case is one extra restart, never a missed one.
    console.error("[devices.reconnect] pending request read failed", {
      tenantId: input.tenantId,
      pairingId: input.pairingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const request = renewedRequest(pending, Date.now());
  const r = await setTenantIntegrationValue({
    tenantId: input.tenantId,
    service: BRIDGE_RECONNECT_SERVICE,
    fieldKey: input.pairingId,
    value: JSON.stringify(request),
    createdBy: input.requestedBy,
  });
  return r.ok ? { ok: true, requestedAt: request.requested_at } : { ok: false, error: r.error };
}

/**
 * At a check-in: should the reply ask this bridge to reconnect? Never throws; a
 * request that cannot be read or saved is answered no (a restart is never
 * guessed) and logged.
 */
export async function reconnectForCheckIn(tenantId: string, pairingId: string, startedAt: string | null): Promise<boolean> {
  try {
    const raw = await getTenantIntegrationValue(tenantId, BRIDGE_RECONNECT_SERVICE, pairingId);
    if (!raw) return false;
    const request = parseReconnectRequest(raw);
    if (!request) {
      // Unreadable: dropped, not kept forever; Refresh can ask again.
      await deleteTenantIntegrationValue({ tenantId, service: BRIDGE_RECONNECT_SERVICE, fieldKey: pairingId });
      return false;
    }
    const decision = reconnectDecision(request, startedAt, Date.now());
    if (decision.next === null) {
      await deleteTenantIntegrationValue({ tenantId, service: BRIDGE_RECONNECT_SERVICE, fieldKey: pairingId });
    } else if (decision.next !== "keep") {
      const saved = await setTenantIntegrationValue({
        tenantId,
        service: BRIDGE_RECONNECT_SERVICE,
        fieldKey: pairingId,
        value: JSON.stringify(decision.next),
      });
      // Told but not remembered: the next check-in would tell the restarted process again.
      if (!saved.ok) {
        console.error("[devices.reconnect] could not record which process was told", { tenantId, pairingId, error: saved.error });
        return false;
      }
    }
    return decision.reconnect;
  } catch (err) {
    console.error("[devices.reconnect] check-in read failed", { tenantId, pairingId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
