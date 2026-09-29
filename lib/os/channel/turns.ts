/**
 * lib/os/channel/turns.ts — every channel turn's outcome, kept as the
 * channel's LAST turn (migration bravo__190_agent_turn_outcomes).
 *
 * WHY. "Ready" used to mean "a key is on file". The header said Working over a
 * key the provider was refusing, because nothing remembered that the last turn
 * failed. app/api/agents/chat now records every turn here, ok or with its
 * failure code (lib/os/channel/outcome.ts), and the department page reads the
 * workspace's rows to say "Not working: …" until a turn succeeds again.
 *
 * One row per (tenant, channel): an upsert, so the table stays the size of the
 * channel list. The history of every turn belongs to the Business Ledger (plan
 * F2), not here.
 *
 * TENANT ISOLATION. Every statement puts the tenant id in its WHERE clause (or
 * its primary key); callers take it from the resolved session, never from a
 * request body.
 *
 * NOT YET APPLIED IS NOT AN OUTAGE. Until the migration runs, a write logs once
 * and records nothing, and a read answers `table_missing`: the page then judges
 * readiness by the key alone, as it did before this table existed. Any other
 * database error is logged and answered as a failed read, never as "no
 * failures".
 */
import "server-only";
import type { Client, ResultSet } from "@libsql/client";
import type { TurnOutcome } from "./outcome";

export type RecordTurnInput = {
  tenantId: string;
  channelKey: string;
  agentSlug: string;
  ok: boolean;
  /** The failure code when !ok (lib/os/channel/outcome.ts); ignored when ok. */
  code: string | null;
  /** ISO-8601 UTC; the caller's clock, so tests pin time. */
  at: string;
};

function isMissingTable(err: unknown): boolean {
  return /no such table: agent_turn_outcomes\b/i.test(err instanceof Error ? err.message : String(err));
}

let missingLogged = false;
function noteMissing(where: string): void {
  if (missingLogged) return;
  missingLogged = true;
  console.error(
    `[os.channel.turns.${where}] agent_turn_outcomes is missing (migration bravo__190 not applied): channel readiness uses the key alone`,
  );
}

/**
 * Record a turn as its channel's last. A turn older than the one already on
 * record (two turns racing) does not overwrite it.
 *
 * Returns what happened; throws only for a database error that is not the
 * missing table, so the caller can log it with its own context.
 */
export async function recordTurnOutcome(db: Client, input: RecordTurnInput): Promise<"recorded" | "table_missing"> {
  if (!input.tenantId) throw new Error("recordTurnOutcome: tenantId is required");
  try {
    await db.execute({
      sql: `INSERT INTO agent_turn_outcomes (tenant_id, channel_key, agent_slug, outcome, code, at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, channel_key) DO UPDATE SET
              agent_slug = excluded.agent_slug,
              outcome = excluded.outcome,
              code = excluded.code,
              at = excluded.at
            WHERE excluded.at >= agent_turn_outcomes.at`,
      args: [input.tenantId, input.channelKey, input.agentSlug, input.ok ? "ok" : "failed", input.ok ? null : input.code, input.at],
    });
    return "recorded";
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    noteMissing("record");
    return "table_missing";
  }
}

export type TurnOutcomesRead =
  | { ok: true; value: TurnOutcome[] }
  | { ok: false; reason: "table_missing" | "read_failed" };

function rows(rs: ResultSet): Array<Record<string, unknown>> {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown as unknown[])[i];
    });
    return o;
  });
}

/** Every channel's last turn in this workspace. */
export async function readTurnOutcomes(db: Client, tenantId: string): Promise<TurnOutcomesRead> {
  if (!tenantId) return { ok: false, reason: "read_failed" };
  try {
    const rs = await db.execute({
      sql: `SELECT channel_key, outcome, code, at FROM agent_turn_outcomes WHERE tenant_id = ? ORDER BY at DESC LIMIT 50`,
      args: [tenantId],
    });
    return {
      ok: true,
      value: rows(rs).map((r) => ({
        channelKey: String(r.channel_key),
        ok: r.outcome === "ok",
        code: r.code == null ? null : String(r.code),
        at: String(r.at),
      })),
    };
  } catch (err) {
    if (isMissingTable(err)) {
      noteMissing("read");
      return { ok: false, reason: "table_missing" };
    }
    console.error("[os.channel.turns.read]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "read_failed" };
  }
}
