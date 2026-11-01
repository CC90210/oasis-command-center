/** Operator-only, bounded production canary. No publishing or bypassed input validation.
 * Credentials must be injected by the sanctioned launcher, never printed or loaded here.
 * --inspect | --enqueue --tool broll_matcher|hook_rewriter|video_download [--url URL]
 * --status JOB_UUID [--wait-seconds 0..180]
 */
import { randomUUID } from "node:crypto";

const EXPECTED_EMAIL = "conaugh@oasisai.work";
const EXPECTED_RUNNER = "bea:oasis-vps-content";
const ALLOWED = new Set(["broll_matcher", "hook_rewriter", "video_download"]);
const TRANSCRIPT = "Canary example, not an account of the operator's life: a small team plans a video beside a laptop, then walks outside to photograph the city skyline. Clear notes help the team decide what to film next.";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("--inspect | --enqueue --tool broll_matcher|hook_rewriter|video_download [--url URL] | --status JOB_UUID [--wait-seconds 0..180]");
    return;
  }
  const modes = ["--inspect", "--enqueue", "--status"].filter(x => process.argv.includes(x));
  if (modes.length !== 1) throw new Error("Choose exactly one bounded canary operation.");
  const wait = Number(arg("--wait-seconds") || "0");
  if (!Number.isInteger(wait) || wait < 0 || wait > 180) throw new Error("Wait must be between 0 and 180 seconds.");
  if (process.env.TURSO_DB_PATH) throw new Error("Live canary refuses a local database override.");
  if (!(process.env.TURSO_DATABASE_URL || process.env.TURSO_DB_URL) || !process.env.TURSO_AUTH_TOKEN) throw new Error("Use the sanctioned credential launcher.");
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
  const { getTursoClient } = await import("../lib/turso");
  const { OASIS_OPERATOR_TENANT_ID, resolvePlatformOperatorForAuthUser } = await import("../lib/platform-operator");
  const { chooseActiveProfile } = await import("../lib/active-profile-resolver");
  const { getJob } = await import("../lib/tools/store");
  const db = getTursoClient();
  try {
    // Email comes from the auth record, not an editable profile field.
    const result = await db.execute({
      sql: `SELECT p.id, p.auth_user_id, p.email, p.tenant_id, p.team_role, p.is_owner, p.admin_access,
                   p.onboarding_completed_at, p.updated_at, p.deactivated_at, a.email AS verified_email
            FROM user_profiles p JOIN _supabase_auth_users a ON a.id = p.auth_user_id
            WHERE p.tenant_id = ? AND LOWER(a.email) = ? AND a.deleted_at IS NULL
              AND (a.banned_until IS NULL OR a.banned_until < ?)`,
      args: [OASIS_OPERATOR_TENANT_ID, EXPECTED_EMAIL, new Date().toISOString()],
    });
    if (!result.rows.length) throw new Error("Active canonical operator account not found in OASIS.");
    const authIds = new Set(result.rows.map(r => String(r.auth_user_id)));
    if (authIds.size !== 1) throw new Error("Ambiguous operator auth identity; refusing to guess.");
    const profile = chooseActiveProfile(result.rows as any, EXPECTED_EMAIL) as any;
    const userId = String(profile.auth_user_id);
    const operator = await resolvePlatformOperatorForAuthUser(userId, EXPECTED_EMAIL);
    if (!operator.operator || profile.deactivated_at || profile.tenant_id !== OASIS_OPERATOR_TENANT_ID) throw new Error("Canonical operator verification failed.");
    const viewer = { tenantId: OASIS_OPERATOR_TENANT_ID, userId, profileId: String(profile.id), email: EXPECTED_EMAIL };
    const runners = (await db.execute({
      sql: "SELECT runner_key, label, tools_json, last_seen_at FROM tool_runners WHERE tenant_id = ? AND last_seen_at >= ?",
      args: [viewer.tenantId, new Date(Date.now() - 10 * 60_000).toISOString()],
    })).rows.map(r => ({ runnerKey: String(r.runner_key), label: String(r.label), tools: JSON.parse(String(r.tools_json)) as string[], lastSeenAt: String(r.last_seen_at) }));
    if (modes[0] === "--inspect") {
      console.log(JSON.stringify({ operation: "read_only", tenant_id: viewer.tenantId, operator_profile_id: viewer.profileId, runners }, null, 2));
      return;
    }
    let id = arg("--status");
    if (modes[0] === "--enqueue") {
      const key = arg("--tool");
      if (!key || !ALLOWED.has(key)) throw new Error("Canary tool is not in the bounded allowlist.");
      const { toolByKey } = await import("../lib/tools/registry");
      const input = key === "video_download" ? { url: arg("--url") } : { transcript: TRANSCRIPT, framework: "nepq" };
      const validated = toolByKey(key)!.validate(input);
      if (!validated.ok) throw new Error(`Registry refused input: ${validated.field}/${validated.code}`);
      const runner = runners.find(r => r.runnerKey === EXPECTED_RUNNER && r.tools.includes(key));
      if (!runner) throw new Error("The expected VPS runner has not advertised this engine as ready.");
      const { handleToolRun } = await import("../lib/tools/session-handlers");
      const response = await handleToolRun(new Request("https://oasisai.work/api/tools/run", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: key, input, idempotency_key: randomUUID() }),
      }), { db, now: () => new Date(), viewer: async () => viewer });
      const body = await response.json() as any;
      if (!response.ok || !body.ok || !body.job?.id) throw new Error(`Queue refused canary: ${response.status}/${body.error || "missing_job"}`);
      id = body.job.id;
      console.log(JSON.stringify({ queued: true, job_id: id, tool: key, tenant_id: viewer.tenantId, operator_profile_id: viewer.profileId }));
    }
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("A valid job UUID is required.");
    const deadline = Date.now() + wait * 1000;
    do {
      const job = await getJob(db, viewer.tenantId, id);
      if (!job || job.createdBy !== viewer.profileId || !ALLOWED.has(job.toolKey)) throw new Error("Canary job does not belong to the verified operator.");
      if (job.claimedBy && job.claimedBy !== EXPECTED_RUNNER) throw new Error("Another runner claimed this job; it does not prove the VPS path.");
      console.log(JSON.stringify({ job_id: job.id, tool: job.toolKey, status: job.status, stage: job.stage,
        claimed_by: job.claimedBy, claimed_at: job.claimedAt, heartbeat_at: job.heartbeatAt,
        heartbeat_advanced_after_claim: Boolean(job.claimedAt && job.heartbeatAt && job.heartbeatAt > job.claimedAt),
        finished_at: job.finishedAt, result: job.result, error: job.errorCode }));
      if (job.status === "done") {
        if (!job.claimedBy || !job.claimedAt || !job.heartbeatAt || !job.finishedAt || !job.result) throw new Error("Completed row is missing lifecycle evidence.");
        return;
      }
      if (job.status === "failed") throw new Error(`Live canary failed: ${job.errorCode}`);
      if (Date.now() >= deadline) {
        if (wait > 0) throw new Error("Canary is still pending; no completion is claimed. Check this job ID again.");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    } while (true);
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Canary failed"); process.exitCode = 1; });
