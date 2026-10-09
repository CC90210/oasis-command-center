/**
 * lib/ai/saved-model-moves.ts - the plan, the move and the exact undo behind
 * scripts/update-saved-models.ts: saved agent_model_config rows whose model
 * lib/ai/model-registry.ts marks gone (retired, served only to past users,
 * past its end date) or ending within REGISTRY_HORIZON_DAYS move to the first
 * replacement on the SAME provider that is not itself ending soon. Nothing
 * else on the row changes: not the key, not the provider.
 *
 * Kept apart from the script so a test can drive each step on a scratch
 * libSQL file (tests/model-registry.checks.ts). It is never imported by the
 * app: it runs only when an operator runs the script.
 */
import type { Client } from "@libsql/client";
import {
  MODEL_REGISTRY,
  REGISTRY_HORIZON_DAYS,
  REGISTRY_PROVIDERS,
  endsWithin,
  isRegistryProvider,
  modelInfo,
  usableReplacement,
} from "./model-registry";

export type SavedRow = {
  id: string;
  tenantId: string;
  userId: string | null;
  agentKey: string;
  provider: string;
  model: string;
  updatedAt: string;
};

export type ModelMove = {
  id: string;
  tenantId: string;
  scope: "workspace" | "personal";
  agentKey: string;
  provider: string;
  from: string;
  to: string;
  /** retired / access_limited / expired: gone now. ending: its end day is within the horizon. */
  reason: string;
  endsOn: string | null;
  sentence: string;
  updatedAtBefore: string;
};

export type MovePlan = {
  judgedAt: string;
  horizonDays: number;
  moves: ModelMove[];
  /** Gone or ending, with no lasting replacement on the same provider: a person must pick. */
  stuck: Array<{ id: string; tenantId: string; provider: string; model: string; reason: string }>;
  /** Models the registry does not know, with how many rows hold each: never touched. */
  unknown: Array<{ provider: string; model: string; rows: number }>;
};

export type MoveLogEntry = ModelMove & { updatedAtAfter: string; applied: boolean };
export type MoveLog = { appliedAt: string; judgedAt: string; entries: MoveLogEntry[] };

/** Every saved row on a provider the registry covers (no key is read). */
export async function readSavedRows(db: Client): Promise<SavedRow[]> {
  const placeholders = REGISTRY_PROVIDERS.map(() => "?").join(", ");
  const res = await db.execute({
    sql: `SELECT id, tenant_id, user_id, agent_key, provider, model, updated_at FROM agent_model_config
          WHERE provider IN (${placeholders}) ORDER BY tenant_id, provider, model, id`,
    args: [...REGISTRY_PROVIDERS],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenant_id),
    userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
    agentKey: String(r.agent_key),
    provider: String(r.provider),
    model: String(r.model),
    updatedAt: String(r.updated_at),
  }));
}

function sentenceFor(provider: string, from: string, to: string, reason: string, endsOn: string | null): string {
  const vendor = isRegistryProvider(provider) ? MODEL_REGISTRY[provider].vendor : provider;
  const fromLabel = modelInfo(provider, from)?.label ?? from;
  const toLabel = modelInfo(provider, to)?.label ?? to;
  const why =
    reason === "access_limited"
      ? `${vendor} no longer offers ${fromLabel} to new accounts`
      : reason === "retired"
        ? `${vendor} retired ${fromLabel}${endsOn ? ` on ${endsOn}` : ""}`
        : reason === "expired"
          ? `${vendor} stopped offering ${fromLabel}${endsOn ? ` on ${endsOn}` : ""}`
          : `${vendor} stops offering ${fromLabel} on ${endsOn}`;
  return `${why}: moves to ${toLabel}`;
}

/** What a move would change, judged against the registry at `now`. Reads nothing. */
export function planMoves(rows: SavedRow[], now: Date): MovePlan {
  const moves: ModelMove[] = [];
  const stuck: MovePlan["stuck"] = [];
  const unknown = new Map<string, { provider: string; model: string; rows: number }>();
  for (const r of rows) {
    if (!isRegistryProvider(r.provider)) continue;
    if (!modelInfo(r.provider, r.model)) {
      const k = `${r.provider}|${r.model}`;
      const seen = unknown.get(k) ?? { provider: r.provider, model: r.model, rows: 0 };
      seen.rows += 1;
      unknown.set(k, seen);
      continue;
    }
    const ending = endsWithin(r.provider, r.model, REGISTRY_HORIZON_DAYS, now);
    if (!ending) continue;
    const next = usableReplacement(r.provider, r.model, now, REGISTRY_HORIZON_DAYS);
    if (!next) {
      stuck.push({ id: r.id, tenantId: r.tenantId, provider: r.provider, model: r.model, reason: ending.reason });
      continue;
    }
    moves.push({
      id: r.id,
      tenantId: r.tenantId,
      scope: r.userId === null ? "workspace" : "personal",
      agentKey: r.agentKey,
      provider: r.provider,
      from: r.model,
      to: next.id,
      reason: ending.reason,
      endsOn: ending.endsOn,
      sentence: sentenceFor(r.provider, r.model, next.id, ending.reason, ending.endsOn),
      updatedAtBefore: r.updatedAt,
    });
  }
  return {
    judgedAt: now.toISOString(),
    horizonDays: REGISTRY_HORIZON_DAYS,
    moves,
    stuck,
    unknown: [...unknown.values()].sort((a, b) => b.rows - a.rows || a.model.localeCompare(b.model)),
  };
}

/** 32-bit FNV-1a of `text` from `seed`, as 8 hex digits. */
function fnv1a(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The plan's fingerprint: which rows it moves, and from what to what (not
 * why, which can change with the date while the move stays the same). The dry
 * run prints it; --apply moves nothing unless the plan it makes then has the
 * same one, so what moves is exactly what was reviewed (PR #555 review). A
 * fingerprint, not a secret.
 */
export function planId(plan: MovePlan): string {
  const text = plan.moves
    .map((m) => [m.id, m.tenantId, m.provider, m.from, m.to].join("|"))
    .sort()
    .join("\n");
  return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x050c5d1f);
}

/**
 * Move each planned row with ONE guarded statement: it changes the row only
 * while it still holds the model the plan read (and only that workspace's
 * row), so a change made since the plan is never overwritten. The log says
 * which rows moved, with what each held before, for an exact undo.
 */
export async function applyMoves(db: Client, plan: MovePlan, at: Date = new Date()): Promise<MoveLog> {
  const appliedAt = at.toISOString();
  const entries: MoveLogEntry[] = [];
  for (const m of plan.moves) {
    const res = await db.execute({
      sql: "UPDATE agent_model_config SET model = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND provider = ? AND model = ?",
      args: [m.to, appliedAt, m.id, m.tenantId, m.provider, m.from],
    });
    entries.push({ ...m, updatedAtAfter: appliedAt, applied: res.rowsAffected === 1 });
  }
  return { appliedAt, judgedAt: plan.judgedAt, entries };
}

/**
 * Put back exactly what a move changed: the old model and the old updated_at,
 * on rows still exactly as the move left them (anything changed since is left
 * alone and reported).
 */
export async function revertMoves(db: Client, log: MoveLog): Promise<Array<{ id: string; restored: boolean }>> {
  const out: Array<{ id: string; restored: boolean }> = [];
  for (const e of log.entries.filter((x) => x.applied)) {
    const res = await db.execute({
      sql:
        "UPDATE agent_model_config SET model = ?, updated_at = ?" +
        " WHERE id = ? AND tenant_id = ? AND provider = ? AND model = ? AND updated_at = ?",
      args: [e.from, e.updatedAtBefore, e.id, e.tenantId, e.provider, e.to, e.updatedAtAfter],
    });
    out.push({ id: e.id, restored: res.rowsAffected === 1 });
  }
  return out;
}

/** The plan, as the script prints it, grouped by workspace. */
export function describePlan(plan: MovePlan, heading: string): string[] {
  const lines = [
    `${heading}: ${plan.moves.length} saved model${plan.moves.length === 1 ? "" : "s"} to move (registry judged at ${plan.judgedAt}, horizon ${plan.horizonDays} days, plan ${planId(plan)})`,
  ];
  const byTenant = new Map<string, ModelMove[]>();
  for (const m of plan.moves) byTenant.set(m.tenantId, [...(byTenant.get(m.tenantId) ?? []), m]);
  for (const [tenantId, moves] of byTenant) {
    lines.push(`workspace ${tenantId}:`);
    for (const m of moves) lines.push(`  ${m.id}  ${m.scope} ${m.agentKey}  ${m.provider}  ${m.from} -> ${m.to}  (${m.sentence})`);
  }
  for (const s of plan.stuck) lines.push(`NO REPLACEMENT (a person must pick): ${s.id} workspace ${s.tenantId} ${s.provider} ${s.model} (${s.reason})`);
  for (const u of plan.unknown) lines.push(`Left alone, not in the registry: ${u.provider} ${u.model} x${u.rows}`);
  return lines;
}

export { REGISTRY_HORIZON_DAYS };
