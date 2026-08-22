/**
 * Reproduce the /api/cron-jobs authenticated path outside the request cycle.
 *
 * The route now reports `handler_threw`, which proves something throws after
 * the auth check — but the browser only shows the error code, not the message.
 * This runs the same three queries through the same accessor so the actual
 * exception is visible. Read-only; it selects and never writes.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "C:\\Users\\User\\Business-Empire-Agent\\tmp\\cron_probe_result.txt";
function log(line: string) {
  console.log(line);
  appendFileSync(OUT, line + "\n", "utf8");
}

async function main() {
  writeFileSync(OUT, "", "utf8");
  const { getServiceSupabase } = await import("../lib/supabase-server");

  let db: ReturnType<typeof getServiceSupabase>;
  try {
    db = getServiceSupabase();
    log("getServiceSupabase(): ok");
  } catch (e) {
    log("getServiceSupabase() THREW: " + (e instanceof Error ? e.message : String(e)));
    return;
  }

  const tenantId = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // oasis-ai-cc

  async function step(label: string, fn: () => PromiseLike<unknown>) {
    try {
      const r = (await fn()) as { error?: { message?: string }; data?: unknown };
      if (r?.error) {
        log(`${label}: returned error -> ${r.error.message}`);
      } else {
        const n = Array.isArray(r?.data) ? r.data.length : r?.data ? 1 : 0;
        log(`${label}: ok (${n} row(s))`);
      }
    } catch (e) {
      log(`${label}: THREW -> ${e instanceof Error ? e.message : e}`);
      if (e instanceof Error && e.stack) log(e.stack.split("\n").slice(1, 4).join("\n"));
    }
  }

  await step("user_profiles.maybeSingle", () =>
    db.from("user_profiles").select("tenant_id").eq("auth_user_id", "00000000-0000-0000-0000-000000000000").maybeSingle(),
  );

  await step("tenant_cron_jobs.select+order", () =>
    db
      .from("tenant_cron_jobs")
      .select(
        "id, agent_key, name, description, schedule, action_type, action_payload, enabled, last_run_at, last_run_status, last_run_output, last_run_error, run_count, created_at, updated_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
  );

  await step("cron_jobs.select+order", () =>
    db
      .from("cron_jobs")
      .select(
        "id, name, description, schedule, action_type, action_config, is_active, last_run_at, last_result, next_run_at, run_count, created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
  );
}

main().catch((e) => {
  log("TOP-LEVEL THREW: " + (e instanceof Error ? e.message : String(e)));
  if (e instanceof Error && e.stack) log(e.stack.split("\n").slice(0, 5).join("\n"));
});
