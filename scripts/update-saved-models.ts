/**
 * Move saved AI models that are gone, or about to go, onto their registry
 * replacement (lib/ai/model-registry.ts), workspace by workspace.
 *
 * WHY (2026-10-08). OASIS's departments failed for nine days on a saved
 * gemini-2.5-pro that Google now serves only to projects that used it before.
 * Calls now send the replacement of a model the registry knows is gone
 * (resolveModelForCall), but the SAVED value stays what it was, so Settings
 * keeps showing it, and a model that is merely ENDING (OpenRouter's
 * google/gemini-2.5-pro carries expiration_date 2026-10-20) is still sent
 * until its last day. This moves every saved agent_model_config row whose
 * model the registry marks retired, served only to past users, past its end
 * date, or ending within 14 days, to the first replacement on the SAME
 * provider that is not itself ending soon (lib/ai/saved-model-moves.ts). The
 * key, the provider and everything else on the row stay as they are.
 *
 *   node --conditions=react-server --import tsx scripts/update-saved-models.ts                          (dry run: what would change, and its plan id)
 *   node --conditions=react-server --import tsx scripts/update-saved-models.ts --apply --expect PLAN    (Bravo only: move exactly that plan)
 *   node --conditions=react-server --import tsx scripts/update-saved-models.ts --revert FILE            (exact undo of an --apply)
 * Against the live database, through the BEA wrapper that hands it the two Turso keys:
 *   python scripts/integrations/occ_turso_run.py scripts/update-saved-models.ts [--apply --expect PLAN | --revert FILE]
 *
 * Options: --log FILE (where --apply writes its undo log; default: the OS temp
 * folder), --json (machine-readable output), --now ISO (a dry run judged at
 * that instant: a rehearsal; refused with --apply, which judges the registry
 * now).
 *
 * WHAT IS REVIEWED IS WHAT MOVES (PR #555 review). The dry run prints a plan
 * id (lib/ai/saved-model-moves.ts planId: which rows, from what, to what).
 * --apply plans again and moves nothing unless that plan has the id passed in
 * --expect: a row that entered the horizon, or changed, since the dry run is
 * never moved unseen. Run the dry run again and review the new plan instead.
 *
 * SAFE TO RE-RUN. Each move is ONE guarded UPDATE: it changes the row only
 * while it still holds the old model (a row someone changed since it was read
 * is left alone and reported). --apply writes every row it changed, with its
 * old model and updated_at, to the undo log; --revert puts exactly those back,
 * and only on rows still exactly as --apply left them. A model the registry
 * does not know is never touched: it is listed, so a person can decide.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { applyMoves, describePlan, planId, planMoves, readSavedRows, revertMoves, type MoveLog } from "../lib/ai/saved-model-moves";

// The hybrid data client falls back to the retired Supabase path unless this
// is exactly turso_cloud. Pin it BEFORE any data module is imported.
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
loadEnvConfig(process.cwd());

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function judgeTime(): Date {
  const raw = arg("--now");
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`--now is not a date: ${raw}`);
  return d;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const expect = arg("--expect");
  // Refused before anything is read: a move happens only on the real date, and
  // only for the plan a dry run showed.
  if (apply && arg("--now")) throw new Error("--now is for a dry run only: --apply judges the registry now. Nothing was changed.");
  if (apply && !expect) throw new Error("--apply needs --expect <plan id> from the dry run you reviewed. Nothing was changed.");
  const { getTursoClient, tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) throw new Error("turso_not_configured: refusing to run without the Turso data client");
  const db = getTursoClient();
  const json = process.argv.includes("--json");

  const revertFile = arg("--revert");
  if (revertFile) {
    const results = await revertMoves(db, JSON.parse(readFileSync(revertFile, "utf8")) as MoveLog);
    if (json) console.log(JSON.stringify({ mode: "revert", results }));
    else {
      for (const r of results) console.log(`${r.restored ? "restored" : "left alone (changed since --apply)"}: ${r.id}`);
      console.log(`REVERT: ${results.filter((r) => r.restored).length} of ${results.length} rows restored exactly`);
    }
    return;
  }

  const plan = planMoves(await readSavedRows(db), judgeTime());
  const id = planId(plan);
  if (!apply) {
    if (json) console.log(JSON.stringify({ mode: "dry_run", planId: id, ...plan }));
    else {
      for (const line of describePlan(plan, "DRY RUN")) console.log(line);
      console.log(
        plan.moves.length
          ? `Nothing was changed. To move exactly these: node --conditions=react-server --import tsx scripts/update-saved-models.ts --apply --expect ${id}`
          : "Nothing to move.",
      );
    }
    return;
  }
  if (id !== expect) {
    throw new Error(
      `The rows to move changed since the dry run (it showed plan ${expect}; now it is ${id}). Nothing was changed. Run the dry run again and review it.`,
    );
  }

  const log = await applyMoves(db, plan);
  const logFile = arg("--log") ?? join(tmpdir(), `update-saved-models-${log.appliedAt.replace(/[:.]/g, "-")}.json`);
  try {
    writeFileSync(logFile, JSON.stringify(log, null, 2));
  } catch (err) {
    // The undo log must not be lost: print it whole.
    console.error(`could not write the undo log to ${logFile}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(JSON.stringify(log));
  }
  if (json) console.log(JSON.stringify({ mode: "apply", planId: id, logFile, ...log, stuck: plan.stuck, unknown: plan.unknown }));
  else {
    for (const line of describePlan(plan, "APPLY")) console.log(line);
    for (const e of log.entries) console.log(`${e.applied ? "moved" : "left alone (changed since it was read)"}: ${e.id}`);
    console.log(`APPLY: ${log.entries.filter((e) => e.applied).length} of ${log.entries.length} rows moved. Undo log: ${logFile}`);
    console.log(`Undo exactly: node --conditions=react-server --import tsx scripts/update-saved-models.ts --revert "${logFile}"`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
