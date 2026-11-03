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
 * attest (lib/cron-auth.ts), so the VPS holding it can only report the allowlisted rows.
 *
 * WRITE. One integrations_health row per service under the OASIS agents owner's profile(s): the rows
 * the Automations panel reads for its viewer (app/api/automations/background-workers/route.ts). Only
 * the registered VPS services are accepted. A reporter that goes quiet reads as "stopped reporting" after
 * the panel's 5-minute freshness rule (DAEMON_HEALTH_STALE_MS).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { verifyStripeSignature } from "@/lib/founders-finances/stripe-signature";
import { readBodyCapped } from "@/lib/ledger/ingest";
import { readAgentsOwner } from "@/lib/agents-owner";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { SUPERVISOR_DISABLED, VPS_ONESHOT_SERVICES } from "@/lib/automations/worker-status";

export const VPS_HEALTH_SERVICES = [
  "vps.oasis-telegram-bridge",
  "vps.oasis-inbox-sweep",
  "vps.oasis-scheduler",
  "vps.oasis-headless-bridge",
  "vps.oasis-content-tools-runner",
  "vps.oasis-workspace-scheduler",
  "vps.atlas-telegram",
  "vps.maven-telegram",
  // Timer-driven one-pass runners (2026-11-02): the Free AI Audit PDF runner and
  // the Meet transcription runner, moved off CC's Mac/PC so jobs run while both are off.
  "vps.oasis-ai-audit-runner",
  "vps.oasis-meet-runner",
] as const;
export type VpsHealthService = (typeof VPS_HEALTH_SERVICES)[number];
export const VPS_HEALTH_STATUSES = ["healthy", "degraded", "down", "running"] as const;
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
    // Only a bounded oneshot pass has a pending result. An always-on
    // process must report its actual supervisor health, not this transient state.
    if (status === "running" && !VPS_ONESHOT_SERVICES.has(service)) return { ok: false, field: "status" };
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

/**
 * The VPS workers CC has switched OFF (vps_unit_controls, 2026-11-03). Their stopped units are
 * reported as the deliberate stop they are, not as an outage. Throws on a failed read.
 */
export async function readSwitchedOffServices(db: Client): Promise<ReadonlySet<string>> {
  const rs = await db.execute("SELECT service FROM vps_unit_controls WHERE desired = 'off'");
  return new Set(rs.rows.map((r) => String(r.service)));
}

/**
 * A stopped unit CC switched off reads as the supervisor's "disabled by operator" (the panel's
 * "Off — you stopped this", the fleet landing and Attention all read it), never as "down". A unit
 * still running after the switch is reported as running: the server has not applied it yet. PURE.
 */
export function asReported(
  s: VpsHeartbeat["services"][number],
  switchedOff: ReadonlySet<string>,
): { status: string; error: string | null; extra: Record<string, unknown> } {
  if (s.status === "down" && switchedOff.has(s.service)) {
    return { status: "degraded", error: null, extra: { pm2_status: SUPERVISOR_DISABLED, switched_off: true } };
  }
  return {
    status: s.status === "running" ? "unknown" : s.status,
    error: s.status === "healthy" || s.status === "running" ? null : s.detail || s.status,
    extra: s.status === "running" ? { phase: "running" } : {},
  };
}

/** Upsert one row per (profile, service). Throws on a failed write. */
export async function recordVpsHeartbeat(
  db: Client,
  input: { tenantId: string; profileIds: string[]; heartbeat: VpsHeartbeat; now: Date; switchedOff?: ReadonlySet<string> },
): Promise<number> {
  const at = input.now.toISOString();
  const switchedOff = input.switchedOff ?? new Set<string>();
  const statements = input.profileIds.flatMap((profileId) =>
    input.heartbeat.services.map((s) => ({ s, r: asReported(s, switchedOff) })).map(({ s, r }) => ({
      sql: `INSERT INTO integrations_health (tenant_id, profile_id, service, status, last_ping_at, last_error, metadata, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (profile_id, service) DO UPDATE SET
              tenant_id = excluded.tenant_id, status = excluded.status, last_ping_at = excluded.last_ping_at,
              last_error = excluded.last_error, metadata = excluded.metadata, updated_at = excluded.updated_at`,
      args: [
        input.tenantId,
        profileId,
        s.service,
        r.status,
        at,
        r.error,
        JSON.stringify({ via: "vps-heartbeat", host: input.heartbeat.host, detail: s.detail, runtime: "remote", ...r.extra }),
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
  switchedOff?: (db: Client) => Promise<ReadonlySet<string>>;
};

export type VpsAuth = { ok: true; raw: string } | { ok: false; response: Response };

/**
 * Secret -> size -> signature (timing-safe, 300 s), shared by every route the VPS calls
 * (/api/internal/vps-health, /api/internal/vps-control). A request that does not authenticate is
 * never parsed.
 */
export async function authenticateVpsRequest(
  req: Request,
  env: Record<string, string | undefined>,
  now: Date,
  maxBytes: number = VPS_HEALTH_BODY_MAX_BYTES,
): Promise<VpsAuth> {
  const secret = (env.CRON_SECRET || "").trim();
  if (secret.length < VPS_HEALTH_SECRET_MIN_LENGTH) {
    return { ok: false, response: json(503, { ok: false, error: "not_installed", detail: "secret_not_set" }) };
  }
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > maxBytes) return { ok: false, response: json(413, { ok: false, error: "body_too_large" }) };
  const raw = await readBodyCapped(req, maxBytes);
  if (raw === null) return { ok: false, response: json(413, { ok: false, error: "body_too_large" }) };

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
    return {
      ok: false,
      response: json(401, { ok: false, error: verdict.reason === "timestamp_outside_tolerance" ? "stale_timestamp" : "unauthorized" }),
    };
  }
  return { ok: true, raw };
}

/**
 * Order: secret -> size -> signature (timing-safe, 300 s) -> JSON -> fields -> owner -> write. A
 * request that does not authenticate is never parsed and nothing is read or written for it.
 */
export async function handleVpsHeartbeat(req: Request, deps: VpsHealthDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const auth = await authenticateVpsRequest(req, env, now);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = JSON.parse(auth.raw);
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
  // Best-effort: an unreadable switch table (or one not yet migrated) leaves every stopped unit
  // reading "down", the honest default, and never blocks the heartbeat.
  let switchedOff: ReadonlySet<string> = new Set();
  try {
    switchedOff = await (deps.switchedOff ?? readSwitchedOffServices)(db);
  } catch (error) {
    console.error("[vps-health] switch read failed", error instanceof Error ? error.message : String(error));
  }
  try {
    const recorded = await recordVpsHeartbeat(db, { tenantId: WEBDEV_TENANT_ID, profileIds: profiles, heartbeat: parsed.value, now, switchedOff });
    return json(200, { ok: true, recorded });
  } catch (error) {
    console.error("[vps-health] write failed", error instanceof Error ? error.message : String(error));
    return json(503, { ok: false, error: "write_failed" });
  }
}
