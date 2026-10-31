/**
 * lib/automations/vps-health.ts - the daemon VPS reports its always-on workers (2026-10-31, CC: "wire
 * the VPS background worker heartbeat ... so BackgroundWorkersPanel shows live green health for the
 * VPS workers").
 *
 * POST /api/internal/vps-health. The reporter on the VPS (CEO-Agent scripts/ops/vps_health_report.py,
 * systemd oasis-vps-health.timer, every minute) sends {host, services: [{service, status, detail}]}.
 *
 * AUTH. HMAC-SHA256 over "<timestamp>.<raw body>", keyed with the Worker's existing CRON_SECRET as
 * text (CC's choice: no new credential), in x-oasis-vps-timestamp / x-oasis-vps-signature, inside a
 * 300 s window, checked timing-safe before anything is parsed or read (the tool runner's scheme,
 * lib/tools/runner-auth.ts). CRON_SECRET alone opens no cron route: those also need the Worker's
 * attest (lib/cron-auth.ts), so the VPS holding it can only report these two rows.
 *
 * WRITE. One integrations_health row per service under the OASIS agents owner's profile(s): the rows
 * the Automations panel reads for its viewer (app/api/automations/background-workers/route.ts). Only
 * the two VPS services are accepted. A reporter that goes quiet reads as "stopped reporting" after
 * the panel's 5-minute freshness rule (DAEMON_HEALTH_STALE_MS).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { verifyStripeSignature } from "@/lib/founders-finances/stripe-signature";
import { readBodyCapped } from "@/lib/ledger/ingest";
import { readAgentsOwner } from "@/lib/agents-owner";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const VPS_HEALTH_SERVICES = ["vps.oasis-telegram-bridge", "vps.oasis-inbox-sweep"] as const;
export type VpsHealthService = (typeof VPS_HEALTH_SERVICES)[number];
export const VPS_HEALTH_STATUSES = ["healthy", "degraded", "down"] as const;
export type VpsHealthStatus = (typeof VPS_HEALTH_STATUSES)[number];

export const HEADER_VPS_TIMESTAMP = "x-oasis-vps-timestamp";
export const HEADER_VPS_SIGNATURE = "x-oasis-vps-signature";
export const VPS_HEALTH_WINDOW_SECONDS = 300;
export const VPS_HEALTH_BODY_MAX_BYTES = 8 * 1024;
export const VPS_HEALTH_SECRET_MIN_LENGTH = 32;
const DETAIL_MAX = 200;

export type VpsHeartbeat = {
  host: string;
  services: Array<{ service: VpsHealthService; status: VpsHealthStatus; detail: string }>;
};

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** The body, or the reason it is refused. PURE. */
export function parseVpsHeartbeat(body: unknown): { ok: true; value: VpsHeartbeat } | { ok: false; field: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: "body" };
  const { host, services } = body as { host?: unknown; services?: unknown };
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(host)) return { ok: false, field: "host" };
  if (!Array.isArray(services) || services.length === 0 || services.length > VPS_HEALTH_SERVICES.length) {
    return { ok: false, field: "services" };
  }
  const seen = new Set<string>();
  const out: VpsHeartbeat["services"] = [];
  for (const raw of services) {
    if (!raw || typeof raw !== "object") return { ok: false, field: "services" };
    const { service, status, detail } = raw as { service?: unknown; status?: unknown; detail?: unknown };
    if (typeof service !== "string" || !(VPS_HEALTH_SERVICES as readonly string[]).includes(service) || seen.has(service)) {
      return { ok: false, field: "service" };
    }
    if (typeof status !== "string" || !(VPS_HEALTH_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, field: "status" };
    }
    if (detail !== undefined && typeof detail !== "string") return { ok: false, field: "detail" };
    seen.add(service);
    out.push({
      service: service as VpsHealthService,
      status: status as VpsHealthStatus,
      detail: String(detail ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, DETAIL_MAX),
    });
  }
  return { ok: true, value: { host, services: out } };
}

/** The OASIS agents owner's profile ids: whose panel reads these rows. Throws on a failed read. */
export async function ownerProfileIds(db: Client, tenantId: string): Promise<string[]> {
  const owner = await readAgentsOwner(tenantId);
  if (owner.state !== "set") throw new Error(`agents_owner_${owner.state}`);
  const rs = await db.execute({
    sql: "SELECT id FROM user_profiles WHERE tenant_id = ? AND auth_user_id = ?",
    args: [tenantId, owner.authUserId],
  });
  return rs.rows.map((r) => String(r.id));
}

/** Upsert one row per (profile, service). Throws on a failed write. */
export async function recordVpsHeartbeat(
  db: Client,
  input: { tenantId: string; profileIds: string[]; heartbeat: VpsHeartbeat; now: Date },
): Promise<number> {
  const at = input.now.toISOString();
  const statements = input.profileIds.flatMap((profileId) =>
    input.heartbeat.services.map((s) => ({
      sql: `INSERT INTO integrations_health (tenant_id, profile_id, service, status, last_ping_at, last_error, metadata, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (profile_id, service) DO UPDATE SET
              tenant_id = excluded.tenant_id, status = excluded.status, last_ping_at = excluded.last_ping_at,
              last_error = excluded.last_error, metadata = excluded.metadata, updated_at = excluded.updated_at`,
      args: [
        input.tenantId,
        profileId,
        s.service,
        s.status,
        at,
        s.status === "healthy" ? null : s.detail || s.status,
        JSON.stringify({ via: "vps-heartbeat", host: input.heartbeat.host, detail: s.detail, runtime: "remote" }),
        at,
      ],
    })),
  );
  if (statements.length === 0) return 0;
  await db.batch(statements, "write");
  return statements.length;
}

export type VpsHealthDeps = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  db?: () => Client | null;
  profileIds?: (db: Client, tenantId: string) => Promise<string[]>;
};

/**
 * Order: secret -> size -> signature (timing-safe, 300 s) -> JSON -> fields -> owner -> write. A
 * request that does not authenticate is never parsed and nothing is read or written for it.
 */
export async function handleVpsHeartbeat(req: Request, deps: VpsHealthDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const secret = (env.CRON_SECRET || "").trim();
  if (secret.length < VPS_HEALTH_SECRET_MIN_LENGTH) {
    return json(503, { ok: false, error: "not_installed", detail: "secret_not_set" });
  }
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > VPS_HEALTH_BODY_MAX_BYTES) return json(413, { ok: false, error: "body_too_large" });
  const raw = await readBodyCapped(req, VPS_HEALTH_BODY_MAX_BYTES);
  if (raw === null) return json(413, { ok: false, error: "body_too_large" });

  const ts = (req.headers.get(HEADER_VPS_TIMESTAMP) || "").trim();
  const sig = (req.headers.get(HEADER_VPS_SIGNATURE) || "").trim().toLowerCase();
  const shaped = /^\d{1,12}$/.test(ts) && /^[0-9a-f]{64}$/.test(sig);
  const verdict = verifyStripeSignature({
    payload: raw,
    header: shaped ? `t=${ts},v1=${sig}` : null,
    secret,
    nowSeconds: Math.floor(now.getTime() / 1000),
    toleranceSeconds: VPS_HEALTH_WINDOW_SECONDS,
  });
  if (!verdict.ok) {
    return json(401, { ok: false, error: verdict.reason === "timestamp_outside_tolerance" ? "stale_timestamp" : "unauthorized" });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(422, { ok: false, error: "invalid_json" });
  }
  const parsed = parseVpsHeartbeat(body);
  if (!parsed.ok) return json(422, { ok: false, error: "invalid_payload", field: parsed.field });

  const db = deps.db ? deps.db() : tursoConfigured() ? getTursoClient() : null;
  if (!db) return json(503, { ok: false, error: "not_installed", detail: "database_not_configured" });
  let profiles: string[];
  try {
    profiles = await (deps.profileIds ?? ownerProfileIds)(db, WEBDEV_TENANT_ID);
  } catch (error) {
    console.error("[vps-health] owner lookup failed", error instanceof Error ? error.message : String(error));
    return json(503, { ok: false, error: "owner_unavailable" });
  }
  if (profiles.length === 0) return json(503, { ok: false, error: "owner_unavailable" });
  try {
    const recorded = await recordVpsHeartbeat(db, { tenantId: WEBDEV_TENANT_ID, profileIds: profiles, heartbeat: parsed.value, now });
    return json(200, { ok: true, recorded });
  } catch (error) {
    console.error("[vps-health] write failed", error instanceof Error ? error.message : String(error));
    return json(503, { ok: false, error: "write_failed" });
  }
}
