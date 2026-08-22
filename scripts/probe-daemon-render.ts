/**
 * TEMPORARY probe — what the Automations tab will actually render.
 *
 * Feeds LIVE integrations_health / cron_jobs values (read read-only from Turso
 * by the harness, piped in as JSON) through the same pure functions the route
 * and the row use, so the output below is the copy the operator will see rather
 * than a description of it. Deleted after the run.
 *
 * Usage: npx tsx scripts/probe-daemon-render.ts <path-to-live.json>
 */
import { readFileSync } from "node:fs";
import {
  daemonBackedCronForName,
  deriveDaemonState,
} from "../lib/automations/daemon-backed-crons";
import { daemonToggleRefusal } from "../lib/automations/daemon-cron-guard";

type Live = {
  health: Array<{ service: string; status: string | null; last_ping_at: string | null }>;
  cron: Array<{ name: string; is_active: number; schedule: string; last_run_at: string | null; run_count: number }>;
};

const live = JSON.parse(readFileSync(process.argv[2], "utf8").replace(/^﻿/, "")) as Live;
const healthByService = new Map(live.health.map((h) => [h.service, h]));

console.log("=== Background workers panel (OASIS) — live health rows ===");
for (const h of live.health) {
  const ageS = h.last_ping_at ? Math.round((Date.now() - Date.parse(h.last_ping_at)) / 1000) : null;
  console.log(`  ${h.service.padEnd(22)} status=${h.status}  last_ping=${h.last_ping_at} (${ageS}s ago)`);
}

console.log("\n=== Cron rows — what the toggle will say ===");
for (const row of live.cron) {
  const def = daemonBackedCronForName(row.name);
  console.log(`  row: "${row.name}"  cron_jobs.is_active=${row.is_active}`);
  if (!def) {
    console.log(`    → ordinary row, toggle reads: ${row.is_active ? "On" : "Off"}`);
    continue;
  }
  const state = deriveDaemonState(def, healthByService.get(def.service) ?? null);
  const toggle =
    state.state === "running" ? "On" : state.state === "unknown" ? "Unknown" : "Off";
  console.log(`    → daemon-backed by ${def.processName}`);
  console.log(`    → daemon state: ${state.state} (reported=${state.reported_status}, stale=${state.stale})`);
  console.log(`    → TOGGLE READS: ${toggle}`);
  console.log(`    → schedule chip: "Continuously — its own process" (parked entry: ${row.schedule})`);
  const refusal = daemonToggleRefusal({ ok: true, name: row.name });
  console.log(`    → PATCH {enabled:true} → HTTP ${refusal?.status} ${refusal?.body.error}`);
}

console.log("\n=== Same row if the bridge went quiet (ping aged past the freshness window) ===");
for (const row of live.cron) {
  const def = daemonBackedCronForName(row.name);
  if (!def) continue;
  const stale = deriveDaemonState(def, {
    status: "healthy",
    last_ping_at: new Date(Date.now() - 22 * 60_000).toISOString(),
  });
  console.log(`  ${def.processName}: state=${stale.state} stale=${stale.stale} last_seen=${stale.last_ping_at}`);
  console.log(`    → TOGGLE READS: ${stale.state === "running" ? "On" : "Unknown"} (never a green from a 22m-old reading)`);
}
