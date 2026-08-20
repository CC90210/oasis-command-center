/**
 * scripts/migrate-application-chase.ts — rebuild the Form 2 completion chase
 * on the live tenant, and re-engage the leads it had abandoned.
 *
 * WHY (Adon, 2026-08-20). Leads who finish the interest form land in
 * `viewed_application` and must complete their personalised full application
 * (Form 2). The chase was two steps, one email then one SMS, and simply ran
 * out: 234 leads in the stage, 232 previously enrolled, and only 15 with any
 * future contact booked. ~217 people were parked there receiving nothing.
 *
 * The reported cause was different from the real one. The unique Form 2 link
 * was never missing: every one of these emails has carried the per-lead link
 * since 2026-08-15. The defect was that the sequence ended.
 *
 * WHAT THIS DOES
 *   1. Rewrites "Viewed application nudge" to the 5-email, ~5-day chase in
 *      lib/drips/sunbiz-application-chase.ts (ONE shared definition, also used
 *      by the tenant seed and the test).
 *   2. Strips the SMS step from that sequence AND from "Signed application —
 *      bank statements nag". Adon: no SMS asking anyone to complete an
 *      application, "not even if it's a live sub". Measured the same day: of
 *      the 90 leads the statements nag texted in 30 days, ALL 90 already had
 *      their statements on file. 127 texts, none necessary.
 *   3. Cancels in-flight SMS rows so nobody receives a text tomorrow from the
 *      old shape.
 *   4. CONTAINS THE SECOND ENGINE. `drip_runs` (the Next.js cron) and
 *      `sequence_state` (the VPS sunbiz-sequence-runner) both read
 *      drip_sequences.steps. 383 leads are enrolled on BOTH for this sequence.
 *      The VPS side does not double-send today only because it fails every row
 *      (668 failures; it expects body_text where the steps store body). That
 *      is a loaded gun: repair the VPS runner and every merchant gets the whole
 *      chase twice. This cancels its non-terminal rows for the sequences we
 *      touch, leaving drip_runs the only writer.
 *   5. --backfill re-engages the dormant leads in paced tranches, starting each
 *      one at the step AFTER the last one they actually received, so nobody
 *      gets the opener twice.
 *
 * DRY-RUN BY DEFAULT. Prints everything and writes nothing. `--apply` performs
 * steps 1 to 4. `--backfill N` additionally enrols N dormant leads and requires
 * --apply. Cancels use a CAS on status so a row the dispatcher claimed mid-run
 * is left to the dispatcher's own recheck; `cancelled` keeps the row's history.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/migrate-application-chase.ts
 *   node --conditions=react-server --import tsx scripts/migrate-application-chase.ts --apply
 *   node --conditions=react-server --import tsx scripts/migrate-application-chase.ts --apply --backfill 40
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

const APPLY = process.argv.includes("--apply");
const backfillArg = process.argv.indexOf("--backfill");
const BACKFILL = backfillArg >= 0 ? parseInt(process.argv[backfillArg + 1] || "0", 10) : 0;

const TENANT_SLUG = "submissions";
const CHASE = "Viewed application nudge";
const STATEMENTS = "Signed application — bank statements nag";
/** Statuses that still represent pending work. */
const LIVE_RUN = ["scheduled", "pending"];
const LIVE_STATE = ["scheduled", "pending", "claimed"];

type Step = { channel?: string; delay_minutes?: number; subject?: string; body?: string };
type Seq = { id: string; name: string; steps: Step[] };

/** Set by main() once the env is loaded; the module imports must not run at
 *  import time or they read env that loadEnvFile has not populated yet. */
let db: Awaited<ReturnType<typeof import("@/lib/supabase-server").getServiceSupabase>>;
let SUNBIZ_VIEWED_APPLICATION_STEPS: Array<{
  channel: string; delay_minutes: number; subject?: string; body: string;
}>;

const log = (s = "") => console.log(s);

/**
 * FAIL CLOSED on every read. A query error that falls through as `?? []` reads
 * as "no rows", and every decision here is driven by row counts: no history
 * means re-send the opener, no pending SMS means nothing to cancel. A transient
 * database error would therefore mail merchants. (Codex review P1 x2.)
 */
function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what} failed: ${res.error.message}`);
  return (res.data ?? []) as T;
}

const parseSteps = (raw: unknown): Step[] => {
  if (Array.isArray(raw)) return raw as Step[];
  try { return JSON.parse(String(raw)) as Step[]; } catch { return []; }
};

// ---------------------------------------------------------------------------
async function main() {
  const supa = await import("@/lib/supabase-server");
  const chaseMod = await import("@/lib/drips/sunbiz-application-chase");
  db = supa.getServiceSupabase();
  SUNBIZ_VIEWED_APPLICATION_STEPS = chaseMod.SUNBIZ_VIEWED_APPLICATION_STEPS as typeof SUNBIZ_VIEWED_APPLICATION_STEPS;

  log(`\n${"=".repeat(70)}`);
  log(`  Form 2 completion chase migration   ${APPLY ? "*** APPLY ***" : "(dry run)"}`);
  log(`${"=".repeat(70)}\n`);

  const t = await db.from("tenants").select("id, slug").eq("slug", TENANT_SLUG).maybeSingle();
  const tenantId = (t.data as { id?: string } | null)?.id;
  if (!tenantId) {
    console.error(`FAIL: tenant '${TENANT_SLUG}' not found. Refusing to guess.`);
    process.exit(1);
  }
  log(`tenant ${TENANT_SLUG} = ${tenantId}\n`);

  const seqRes = await db
    .from("drip_sequences")
    .select("id, name, steps")
    .eq("tenant_id", tenantId)
    .in("name", [CHASE, STATEMENTS]);
  const seqRows = must(seqRes, "read drip_sequences");
  const seqs = seqRows.map((r) => {
    const row = r as { id: string; name: string; steps: unknown };
    return { id: row.id, name: row.name, steps: parseSteps(row.steps) } as Seq;
  });
  const chase = seqs.find((s) => s.name === CHASE);
  const statements = seqs.find((s) => s.name === STATEMENTS);
  if (!chase) {
    console.error(`FAIL: sequence "${CHASE}" not found on this tenant.`);
    process.exit(1);
  }

  // ---- 1. the chase rewrite ------------------------------------------------
  log("── 1. Viewed application nudge ────────────────────────────────────────");
  log(`   BEFORE  ${chase.steps.length} steps`);
  chase.steps.forEach((s, i) =>
    log(`     ${i} [${s.channel}] +${s.delay_minutes}m  ${(s.subject || "(no subject)").slice(0, 52)}`),
  );
  log(`   AFTER   ${SUNBIZ_VIEWED_APPLICATION_STEPS.length} steps`);
  SUNBIZ_VIEWED_APPLICATION_STEPS.forEach((s, i) =>
    log(`     ${i} [${s.channel}] +${s.delay_minutes}m  ${(s.subject || "").slice(0, 52)}`),
  );
  const days = SUNBIZ_VIEWED_APPLICATION_STEPS.reduce((n, s) => n + s.delay_minutes, 0) / 1440;
  log(`   span    ~${days.toFixed(1)} days, email only\n`);

  // ---- 2. statements nag: drop SMS only -----------------------------------
  let statementsKept: Step[] = [];
  if (statements) {
    statementsKept = statements.steps.filter((s) => (s.channel || "email") !== "sms");
    const dropped = statements.steps.length - statementsKept.length;
    log("── 2. Signed application, bank statements nag ─────────────────────────");
    log(`   ${statements.steps.length} steps -> ${statementsKept.length} (dropping ${dropped} SMS)`);
    log("   email steps are left exactly as they are\n");
  } else {
    log("── 2. Signed application nag: sequence not found, skipping\n");
  }

  const targetIds = [chase.id, ...(statements ? [statements.id] : [])];

  // ---- 3. in-flight SMS rows ----------------------------------------------
  const smsRuns = await db
    .from("drip_runs")
    .select("id, tenant_id, lead_id, sequence_name, step_index, status")
    .eq("tenant_id", tenantId)
    .in("sequence_id", targetIds)
    .eq("channel", "sms")
    .in("status", LIVE_RUN);
  // Fail closed: reading this as zero would report "nothing to cancel" and
  // leave scheduled texts alive, which is the one thing this migration exists
  // to stop. (Codex review P1.)
  const smsRows = must(smsRuns, "read scheduled SMS runs") as Array<{ id: string; sequence_name: string; status: string }>;
  log("── 3. In-flight SMS (would text a merchant from the old shape) ────────");
  log(`   ${smsRows.length} row(s) to cancel in drip_runs\n`);

  // ---- 4. the second engine -----------------------------------------------
  const stateRes = await db
    .from("sequence_state")
    .select("id, sequence_id, lead_id, status")
    .eq("tenant_id", tenantId)
    .in("sequence_id", targetIds)
    .in("status", LIVE_STATE);
  const stateRows = must(stateRes, "read sequence_state") as Array<{ id: string; status: string }>;
  log("── 4. Second engine containment (VPS sequence_state) ──────────────────");
  log(`   ${stateRows.length} non-terminal row(s) to cancel so it cannot double-send\n`);

  // ---- 5. who is dormant ---------------------------------------------------
  const dormant = await findDormant(tenantId, chase.id);
  log("── 5. Dormant leads in viewed_application ─────────────────────────────");
  log(`   ${dormant.length} lead(s) with an email and NO pending contact`);
  log(`   resume points: ${summarizeResume(dormant)}`);
  if (BACKFILL > 0) log(`   this run would enrol ${Math.min(BACKFILL, dormant.length)}`);
  else log(`   (pass --backfill N to enrol a tranche; nothing enrolled this run)`);
  log("");

  if (!APPLY) {
    log("DRY RUN. Nothing written. Re-run with --apply.\n");
    return;
  }

  // ---- writes --------------------------------------------------------------
  // Everything below depends on the new step list being live. Cancelling a
  // lead's SMS and enrolling them at new step 3 while the sequence is still the
  // old two-step definition would fire the wrong copy at a merchant, or
  // nothing at all. Abort rather than half-migrate. (Codex review P1.)
  const upd = await db
    .from("drip_sequences")
    .update({ steps: JSON.stringify(SUNBIZ_VIEWED_APPLICATION_STEPS), updated_at: new Date().toISOString() })
    .eq("id", chase.id)
    .eq("tenant_id", tenantId);
  if (upd.error) {
    throw new Error(
      `chase rewrite failed: ${upd.error.message}. Nothing else was written; the sequence is unchanged and safe to retry.`,
    );
  }
  log("   chase rewritten");

  if (statements && statementsKept.length !== statements.steps.length) {
    const u2 = await db
      .from("drip_sequences")
      .update({ steps: JSON.stringify(statementsKept), updated_at: new Date().toISOString() })
      .eq("id", statements.id)
      .eq("tenant_id", tenantId);
    if (u2.error) throw new Error(`statements nag rewrite failed: ${u2.error.message}`);
    log("   statements nag: SMS removed");
  }

  // Containment must SUCCEED before anyone is enrolled. A rejected cancel leaves
  // a scheduled text alive, or leaves the legacy VPS runner able to claim the
  // sequence, and enrolling on top of either is exactly the harm this migration
  // exists to prevent. A CAS miss (no error, row already claimed by the
  // dispatcher) is fine and is NOT an error; a real database error is fatal.
  // (Codex review P1, round 2.)
  const containmentErrors: string[] = [];

  let cancelledRuns = 0;
  for (const r of smsRows) {
    const c = await db
      .from("drip_runs")
      .update({ status: "cancelled", last_error: "sms removed from application chase (2026-08-20)" })
      .eq("id", r.id)
      .eq("status", r.status); // CAS: leave anything the dispatcher just claimed
    if (c.error) containmentErrors.push(`drip_runs ${r.id}: ${c.error.message}`);
    else cancelledRuns += 1;
  }
  log(`   cancelled ${cancelledRuns}/${smsRows.length} in-flight SMS run(s)`);

  let cancelledState = 0;
  for (const r of stateRows) {
    const c = await db
      .from("sequence_state")
      .update({ status: "cancelled", last_error: "superseded by drip_runs; VPS runner contained (2026-08-20)" })
      .eq("id", r.id)
      .eq("status", r.status);
    if (c.error) containmentErrors.push(`sequence_state ${r.id}: ${c.error.message}`);
    else cancelledState += 1;
  }
  log(`   cancelled ${cancelledState}/${stateRows.length} VPS sequence_state row(s)`);

  if (containmentErrors.length) {
    throw new Error(
      `containment incomplete (${containmentErrors.length} cancel(s) failed) — NOT enrolling anyone. ` +
      `The sequence rewrite is live and safe; re-run to finish containment. First error: ${containmentErrors[0]}`,
    );
  }

  if (BACKFILL > 0) {
    const tranche = dormant.slice(0, BACKFILL);
    let enrolled = 0;
    for (const [i, lead] of tranche.entries()) {
      const step = SUNBIZ_VIEWED_APPLICATION_STEPS[lead.resumeIndex];
      if (!step) continue;
      // Spread across the hour so a tranche never lands as one burst.
      const when = new Date(Date.now() + step.delay_minutes * 60_000 + i * 90_000).toISOString();
      const ins = await db.from("drip_runs").insert({
        tenant_id: tenantId,
        lead_id: lead.id,
        sequence_id: chase.id,
        sequence_name: CHASE,
        step_index: lead.resumeIndex,
        channel: "email",
        scheduled_for: when,
        status: "scheduled",
      });
      if (!ins.error) enrolled += 1;
    }
    log(`   enrolled ${enrolled}/${tranche.length} dormant lead(s); ${dormant.length - tranche.length} still waiting`);
  }

  log("\nDone.\n");
}

/**
 * Leads sitting in viewed_application with a usable email and NOTHING pending.
 * `resumeIndex` is the step AFTER the highest one they actually received, so a
 * re-engaged lead never gets the opener twice.
 */
async function findDormant(tenantId: string, sequenceId: string) {
  const recs = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .eq("data->>stage", "viewed_application");
  // Fail closed like every other decision read: an error swallowed as zero rows
  // would rewrite and cancel the old sequences, re-engage nobody, and report
  // success. (Codex review P2, round 2.)
  const leadRows = must(recs, "read viewed_application leads") as Array<{
    id: string; data: Record<string, unknown>;
  }>;
  const leads = leadRows.filter(
    (r) => typeof r.data?.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.data.email as string),
  );

  const runsRes = await db
    .from("drip_runs")
    .select("lead_id, step_index, status, channel")
    .eq("tenant_id", tenantId)
    .eq("sequence_id", sequenceId);
  // Fail closed: an error read as "no rows" makes every lead look like it has
  // no history, and the backfill would mail the opener to people who already
  // got it. (Codex review P1.)
  const runRows = must(runsRes, "read drip_runs history") as Array<{
    lead_id: string; step_index: number; status: string; channel: string;
  }>;
  const byLead = new Map<string, { pending: boolean; emailsSeen: Set<number> }>();
  for (const r of runRows) {
    const cur = byLead.get(r.lead_id) || { pending: false, emailsSeen: new Set<number>() };
    // A pending SMS does NOT count as being chased: this migration cancels
    // every one of them. Counting it would exclude exactly those leads from the
    // backfill and then cancel their only remaining contact, leaving them with
    // nothing — the precise outcome this migration exists to prevent. Ignoring
    // SMS here also keeps the dry run and the apply run in agreement, rather
    // than depending on which ran first. (Codex review P1.)
    if (LIVE_RUN.includes(r.status) && (r.channel || "email") === "email") cur.pending = true;
    // Count EMAILS RECEIVED, not the raw step index.
    //
    // The step numbering changed underneath these leads: the old sequence was
    // [0 email, 1 SMS], the new one is five emails. Resuming at
    // maxSentIndex + 1 would put anyone who got the old SMS at new step 2 and
    // skip new step 1 — which is the strongest message in the arc (the bank
    // statements are the gating piece). Measured on the live data that was 176
    // of 217 leads silently robbed of the best email.
    //
    // Counting delivered EMAILS instead is stable across the renumbering: the
    // old sequence had exactly one email, so a lead who received it resumes at
    // index 1 and gets every new message exactly once.
    if ((r.status === "sent" || r.status === "done") && (r.channel || "email") === "email") {
      cur.emailsSeen.add(r.step_index);
    }
    byLead.set(r.lead_id, cur);
  }

  const out: Array<{ id: string; resumeIndex: number }> = [];
  for (const lead of leads) {
    const st = byLead.get(lead.id);
    if (st?.pending) continue; // already being chased
    const emailsReceived = st ? st.emailsSeen.size : 0;
    if (emailsReceived >= SUNBIZ_VIEWED_APPLICATION_STEPS.length) continue; // arc complete
    out.push({ id: lead.id, resumeIndex: emailsReceived });
  }
  return out;
}

function summarizeResume(rows: Array<{ resumeIndex: number }>): string {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.resumeIndex, (counts.get(r.resumeIndex) || 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([i, n]) => `step ${i}: ${n}`).join(", ") || "none";
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
