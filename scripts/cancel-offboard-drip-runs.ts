/**
 * scripts/cancel-offboard-drip-runs.ts — cancel the queued drip steps aimed at
 * merchants who are NOT on the Leads board.
 *
 * WHY THIS IS NEEDED ON TOP OF THE CODE FIX. The enroller and the dispatcher now
 * both apply the board rule, so nothing new can be queued at an off-board lead
 * and nothing already queued will SEND. But the rows sit there in `scheduled`
 * until each one's due time comes round and dispatch cancels it individually,
 * which means the queue keeps reporting work it will never do — and a health
 * check reading pending counts sees a backlog that is actually a graveyard.
 * This clears them in one pass so the queue says what is true.
 *
 * Measured 2026-08-11: 126 of 521 pending runs, including all 61 of the
 * "Declined - 1-month check-back" (every declined lead is transferred, so that
 * sequence has no audience at all).
 *
 * DRY-RUN BY DEFAULT. It prints the full list and writes nothing. `--apply`
 * performs the cancel, and only rows still in `scheduled` are touched, with a
 * CAS on status so a row the dispatcher claimed mid-run is left to the
 * dispatcher's own recheck. `cancelled` is not destructive: the row keeps its
 * history and a lead that legitimately returns to the board re-enrolls cleanly.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/cancel-offboard-drip-runs.ts
 *   node --conditions=react-server --import tsx scripts/cancel-offboard-drip-runs.ts --apply
 */

import { readFileSync } from "node:fs";

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnvFile("C:/Users/echel/JARVIS/.env.agents");

const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const APPLY = process.argv.includes("--apply");
const REASON = "off_board_backfill: lead is not on the Leads board (2026-08-11)";

/** Chunked so a long id list cannot overflow the PostgREST query string. */
const CHUNK = 100;

async function main(): Promise<void> {
  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const { isOnLeadsBoard } = await import("@/lib/leads/board-visibility");
  const db = getServiceSupabase();

  const runsRes = await db
    .from("drip_runs")
    .select("id, lead_id, sequence_id, step_index, scheduled_for, status")
    .eq("tenant_id", TENANT)
    .in("status", ["scheduled"]);
  if (runsRes.error) throw new Error(`drip_runs read failed: ${runsRes.error.message}`);
  const runs = (runsRes.data || []) as Array<{
    id: string;
    lead_id: string;
    sequence_id: string;
    step_index: number;
    scheduled_for: string;
  }>;
  if (runs.length === 0) {
    console.log("no scheduled runs; nothing to do");
    return;
  }

  // Sequence names, so the printed list is readable by a human deciding whether
  // to approve it. A run id tells nobody anything.
  const seqRes = await db.from("drip_sequences").select("id, name").eq("tenant_id", TENANT);
  const seqName = new Map(
    ((seqRes.data || []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]),
  );

  // Only stage-triggered sequences are governed by the board rule; a
  // flag-triggered chase owns its own lifecycle.
  const stageTriggered = new Set<string>();
  {
    const r = await db.from("drip_sequences").select("id, trigger_filter").eq("tenant_id", TENANT);
    for (const s of (r.data || []) as Array<{ id: string; trigger_filter: unknown }>) {
      const f = (s.trigger_filter || {}) as Record<string, unknown>;
      const isStage = (!f.field || f.field === "stage") && (!f.entity || f.entity === "lead");
      if (isStage && typeof f.to === "string" && f.to.trim()) stageTriggered.add(s.id);
    }
  }

  const leadIds = [...new Set(runs.map((r) => r.lead_id))];
  const leadData = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const r = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", TENANT)
      .eq("entity_type", "lead")
      .in("id", leadIds.slice(i, i + CHUNK));
    if (r.error) throw new Error(`lead read failed: ${r.error.message}`);
    for (const row of (r.data || []) as Array<{ id: string; data: Record<string, unknown> }>) {
      leadData.set(row.id, row.data || {});
    }
  }

  const doomed = runs.filter((run) => {
    if (!stageTriggered.has(run.sequence_id)) return false;
    const data = leadData.get(run.lead_id);
    // A run whose lead we could not read is LEFT ALONE. Absence of evidence is
    // not evidence the lead is off the board, and cancelling on a failed read
    // would delete live sequences on any transient error.
    if (!data) return false;
    return !isOnLeadsBoard(data);
  });

  const bySeq = new Map<string, number>();
  for (const r of doomed) {
    const n = seqName.get(r.sequence_id) || r.sequence_id;
    bySeq.set(n, (bySeq.get(n) || 0) + 1);
  }

  console.log(`scheduled runs:        ${runs.length}`);
  console.log(`off-board, to cancel:  ${doomed.length}`);
  console.log("");
  for (const [name, n] of [...bySeq].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${name}`);
  }
  console.log("");
  for (const r of doomed) {
    const d = leadData.get(r.lead_id) || {};
    console.log(
      `  ${r.id}  step ${r.step_index}  due ${String(r.scheduled_for).slice(0, 16)}  ` +
        `stage=${String(d.stage ?? "?")}  transferred=${String(d.transferred_at ?? "-").slice(0, 10)}  ` +
        `${seqName.get(r.sequence_id) || ""}`,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to cancel these.");
    return;
  }
  if (doomed.length === 0) return;

  let cancelled = 0;
  for (let i = 0; i < doomed.length; i += CHUNK) {
    const ids = doomed.slice(i, i + CHUNK).map((r) => r.id);
    const w = await db
      .from("drip_runs")
      .update({ status: "cancelled", last_error: REASON })
      .in("id", ids)
      // CAS: a row the dispatcher claimed between our read and this write stays
      // 'sending' and is handled by the dispatcher's own off-board recheck.
      .eq("status", "scheduled")
      .select("id");
    if (w.error) throw new Error(`cancel failed: ${w.error.message}`);
    cancelled += (w.data || []).length;
  }
  console.log(`\ncancelled ${cancelled} of ${doomed.length} (any shortfall was claimed mid-run)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
