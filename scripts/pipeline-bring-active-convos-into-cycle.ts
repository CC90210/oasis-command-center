/**
 * One-time: bring the active people's live conversations onto the board
 * (CC, 2026-09-24 — "Bring in active convos").
 *
 * The board shows only the current revenue cycle (lib/pipeline-cycle.ts), so
 * leads CC, Adon, David and Schneur were already working before the
 * 2026-09-23 boundary were invisible on it. This stamps pipeline_cycle on the
 * ones PAST first contact — attempting_contact, connected, qualified,
 * founder_meeting_booked — owned by someone on the ACTIVE assignment roster.
 * Never-contacted "assigned" rows stay in their owners' Leads books, off the
 * board. Nothing else on the lead changes (owner, clocks, stage).
 *
 *   node --conditions=react-server --import tsx scripts/pipeline-bring-active-convos-into-cycle.ts            (dry run)
 *   node --conditions=react-server --import tsx scripts/pipeline-bring-active-convos-into-cycle.ts --apply
 *
 * Compare-and-set on updated_at: a lead edited while this runs is skipped and
 * reported, never overwritten. Reversible: remove data.pipeline_cycle.
 */

import { loadEnvConfig } from "@next/env";

process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
loadEnvConfig(process.cwd());

const STAGES = ["attempting_contact", "connected", "qualified", "founder_meeting_booked"];

async function main() {
  const apply = process.argv.includes("--apply");
  const { getTursoClient, tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) throw new Error("turso_not_configured");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { CURRENT_OASIS_PIPELINE_CYCLE } = await import("../lib/pipeline-cycle");
  const { getOasisPipelineAssignmentRoster } = await import("../lib/team");

  const roster = await getOasisPipelineAssignmentRoster(WEBDEV_TENANT_ID);
  const owners = new Map(
    roster
      .filter((m) => m.auth_user_id)
      .map((m) => [m.auth_user_id!.trim().toLowerCase(), m.display_name || m.full_name] as const),
  );
  console.log(`mode: ${apply ? "APPLY" : "dry run"}; active roster: ${[...owners.values()].join(", ")}`);

  const db = getTursoClient();
  const placeholders = STAGES.map(() => "?").join(", ");
  const rows = (
    await db.execute({
      sql: `SELECT id, updated_at, json_extract(data, '$.stage') AS stage, json_extract(data, '$.assigned_to') AS owner,
                   json_extract(data, '$.pipeline_cycle') AS cycle
              FROM tenant_records
             WHERE tenant_id = ? AND entity_type = 'lead' AND json_extract(data, '$.stage') IN (${placeholders})`,
      args: [WEBDEV_TENANT_ID, ...STAGES],
    })
  ).rows as unknown as Array<{ id: string; updated_at: string; stage: string; owner: string | null; cycle: string | null }>;

  const targets = rows.filter(
    (r) => r.owner && owners.has(String(r.owner).trim().toLowerCase()) && r.cycle !== CURRENT_OASIS_PIPELINE_CYCLE.id,
  );
  const byOwner = new Map<string, Record<string, number>>();
  for (const r of targets) {
    const name = owners.get(String(r.owner).trim().toLowerCase()) || "?";
    const counts = byOwner.get(name) || {};
    counts[r.stage] = (counts[r.stage] || 0) + 1;
    byOwner.set(name, counts);
  }
  for (const [name, counts] of byOwner) console.log(`  ${name}: ${JSON.stringify(counts)}`);
  console.log(`total to bring onto the board: ${targets.length}`);
  if (!apply) return;

  let stamped = 0;
  const skipped: string[] = [];
  const now = new Date().toISOString();
  for (const r of targets) {
    const res = await db.execute({
      sql: `UPDATE tenant_records SET data = json_set(data, '$.pipeline_cycle', ?), updated_at = ?
             WHERE id = ? AND tenant_id = ? AND updated_at = ?`,
      args: [CURRENT_OASIS_PIPELINE_CYCLE.id, now, r.id, WEBDEV_TENANT_ID, r.updated_at],
    });
    if (res.rowsAffected === 1) stamped += 1;
    else skipped.push(r.id);
  }
  console.log(`stamped ${stamped}; skipped (edited mid-run) ${skipped.length}${skipped.length ? `: ${skipped.join(", ")}` : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
