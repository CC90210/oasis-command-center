/**
 * DRY RUN ONLY — inspect the current OASIS pipeline cycle and optionally write
 * a local restoration manifest. This script has no apply mode and performs no
 * database mutation.
 *
 *   node --conditions=react-server --import tsx scripts/plan-oasis-pipeline-cycle.ts
 *   node --conditions=react-server --import tsx scripts/plan-oasis-pipeline-cycle.ts --archive
 *   node --conditions=react-server --import tsx scripts/plan-oasis-pipeline-cycle.ts --json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { getDataBackendMode } from "../lib/backend-mode";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import { getTursoClient, tursoConfigured } from "../lib/turso";
import { WEBDEV_TENANT_ID } from "../lib/web-leads/tenant";
import { getOasisPipelineAssignmentRoster } from "../lib/team";
import {
  CURRENT_OASIS_PIPELINE_CYCLE,
  planPipelineCycleArchive,
  type PipelineCycleRow,
} from "../lib/pipeline-cycle";

const PAGE_SIZE = 1_000;

function plannerDataClient() {
  // CLI scripts do not get Next's automatic environment bootstrap. Respect an
  // already injected/local test configuration; otherwise load the app's
  // standard Next env files. This never searches external agent secret stores
  // and never prints a credential value.
  if (!tursoConfigured()) loadEnvConfig(process.cwd());

  if (getDataBackendMode() !== "turso") {
    throw new Error(
      "pipeline_cycle_requires_turso: refusing the retired Supabase data path",
    );
  }
  if (!tursoConfigured()) {
    throw new Error(
      "pipeline_cycle_turso_not_configured: set TURSO_DB_PATH or " +
        "TURSO_DATABASE_URL with TURSO_AUTH_TOKEN; refusing Supabase fallback",
    );
  }
  return createTursoPostgrest(getTursoClient());
}

async function readAllLeadRows(): Promise<PipelineCycleRow[]> {
  const db = plannerDataClient();
  const rows: PipelineCycleRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await db
      .from("tenant_records")
      .select("id,data,updated_at")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("entity_type", "lead")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (result.error) throw new Error(`pipeline_cycle_read_failed: ${result.error.message}`);
    const page = (result.data || []) as PipelineCycleRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function main() {
  const [rows, roster] = await Promise.all([
    readAllLeadRows(),
    getOasisPipelineAssignmentRoster(WEBDEV_TENANT_ID),
  ]);
  const rosterIds = roster.flatMap((member) => member.auth_user_id ? [member.auth_user_id] : []);
  const plan = planPipelineCycleArchive(rows, CURRENT_OASIS_PIPELINE_CYCLE, rosterIds);
  const archive = {
    version: 1,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    assignmentRoster: roster.map((member) => ({
      email: member.email,
      userId: member.auth_user_id,
      displayName: member.display_name || member.full_name || member.email,
    })),
    ...plan,
  };

  if (process.argv.includes("--archive")) {
    const dir = resolve(process.cwd(), "tmp", "pipeline-cycle");
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, `${CURRENT_OASIS_PIPELINE_CYCLE.id}-dry-run.json`);
    await writeFile(path, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(`DRY RUN archive written: ${path}`);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(archive, null, 2));
    return;
  }
  console.log("DRY RUN — no database rows changed");
  console.log(`cycle: ${plan.cycle.id} (${plan.cycle.startedAt})`);
  console.log(`current rows: ${plan.current.length}`);
  console.log(`prior-cycle rows hidden/restorable: ${plan.archive.length}`);
  console.log(`current rows outside CC+Adon roster: ${plan.outsideAssignmentRoster.length}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    if (tursoConfigured()) getTursoClient().close();
  });
