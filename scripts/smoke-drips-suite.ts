/**
 * scripts/smoke-drips-suite.ts — end-to-end smoke tests for the Drips surfaces,
 * against PRODUCTION data, through the real modules.
 *
 * Adon, 2026-08-11: "start running internal smoke tests now to test the
 * functionality... changing the template, testing what happens when you change
 * the volume, and then ensuring that everything is active in the Activity Tab
 * as well that you could turn on and off in the Manage Tab."
 *
 * WHY THIS EXISTS ON TOP OF THE UNIT TESTS. The unit tests run on fixtures I
 * wrote, and a fixture encodes the same belief the code does — which is exactly
 * how the TextTorrent timezone bug survived twelve review rounds, and how the
 * per-sequence chart shipped splitting one sequence into two rows while every
 * fixture passed. These run the real query shapes and the real rules against
 * the real database.
 *
 * SAFETY. Drips are LIVE and 8 of 11 sequences are enabled. Every write here
 * targets the isolated fixture from smoke-drips-fixture.mjs, whose trigger stage
 * `apex_smoke_test` no lead has ever been in and whose pool templates sit under
 * that same stage — so nothing here can select copy for a live sequence or
 * enrol a merchant. Reads run against real production rows.
 *
 * Run:
 *   node scripts/smoke-drips-fixture.mjs setup
 *   npx tsx scripts/smoke-drips-suite.ts
 *   node scripts/smoke-drips-fixture.mjs teardown
 */

import { execFileSync } from "node:child_process";
import { classifyRunStatus, summarizeFailures, isHeldForPolicy, outcomeWindow } from "../lib/drips/activity-core";
import {
  selectableTemplates,
  validateInterchange,
  diffPins,
  effectiveRole,
  brandFromTriggerFilter,
  stageFromTriggerFilter,
} from "../lib/drips/template-interchange";
import { resolveCopy, poolFor, type PoolTemplate } from "../lib/drips/template-pool";
import { parseDripSteps, type DripStep } from "../lib/drips/types";
import {
  bucketBySequenceDay,
  joinVolumeToSequences,
  parseSequenceDailyCap,
  sequenceRemaining,
  sequenceNameFromSource,
  dayKey,
} from "../lib/drips/sequence-volume-core";
import { emailGateReason, consumeEmail, holdUntilIso, type EmailBudget } from "../lib/drips/drip-rules-core";

const DB = "bravo-empire";
const TURSO = "C:/Users/echel/JARVIS/scripts/turso_sql.mjs";
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const SEQ_ID = "a9e5f000-5b0c-4e00-0000-000000000001";
const STAGE = "apex_smoke_test";
const TPL_A = "a9e5f000-0000-4e00-0000-0000000000aa";
const TPL_B = "a9e5f000-0000-4e00-0000-0000000000bb";
const TPL_OPENER = "a9e5f000-0000-4e00-0000-0000000000cc";
const TPL_RETIRED = "a9e5f000-0000-4e00-0000-0000000000dd";
const TZ = process.env.OPERATOR_TIMEZONE || "America/Toronto";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

function sql<T = Record<string, unknown>>(query: string, write = false): T[] {
  const args = [TURSO, "--db", DB];
  if (write) args.push("--write");
  args.push("--sql", query);
  const out = execFileSync("node", args, { encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  const rows: T[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(t) as T);
    } catch {
      /* trailing count line */
    }
  }
  return rows;
}
const q = (s: unknown) => `'${String(s).replace(/'/g, "''")}'`;
const jparse = <T,>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** The fixture's steps as the app would see them, through the REAL validator. */
function fixtureSteps(): DripStep[] {
  const row = sql<{ steps: string }>(`select steps from drip_sequences where id = ${q(SEQ_ID)}`)[0];
  if (!row) throw new Error("fixture sequence missing — run: node scripts/smoke-drips-fixture.mjs setup");
  return parseDripSteps(jparse<unknown[]>(row.steps, []));
}

function fixturePool(): PoolTemplate[] {
  return sql<Record<string, unknown>>(
    `select id, brand, stage, role, subject, body_text, status, weight from drip_template_pool where stage = ${q(STAGE)}`,
  ).map((r) => ({
    id: String(r.id),
    brand: String(r.brand) as PoolTemplate["brand"],
    stage: String(r.stage),
    role: String(r.role),
    subject: String(r.subject || ""),
    bodyText: String(r.body_text || ""),
    status: String(r.status) as PoolTemplate["status"],
    weight: Number(r.weight ?? 1),
  }));
}

async function main(): Promise<void> {
  console.log("DRIPS SMOKE SUITE — production data, isolated writes\n");

  // ══ 1. ACTIVITY TAB ══════════════════════════════════════════════════════
  section("1. Activity tab — what actually went out");
  {
    const runs = sql<Record<string, unknown>>(
      `select id, status, from_identity, last_error, sent_at, scheduled_for, channel, sequence_name
       from drip_runs where tenant_id = ${q(TENANT)}
       and (sent_at >= datetime('now','-7 days') or (sent_at is null and scheduled_for >= datetime('now','-7 days')))
       limit 4000`,
    );
    console.log(`  drip_runs in the 7-day outcome window: ${runs.length}`);
    check("the activity window returns rows", runs.length > 0, `${runs.length}`);

    const classified = runs.map((r) => classifyRunStatus(r as never));
    const counts: Record<string, number> = {};
    for (const c of classified) counts[c] = (counts[c] || 0) + 1;
    console.log(`  classified: ${JSON.stringify(counts)}`);

    // THE headline claim of the tab: status='sent' overstates real sends.
    const rawSent = runs.filter((r) => r.status === "sent" || r.status === "done").length;
    const realSends = classified.filter((c) => c === "sent").length;
    check(
      "raw status never UNDERSTATES real sends (the discriminator only removes)",
      rawSent >= realSends,
      `raw ${rawSent} >= real ${realSends}`,
    );
    check(
      "the discriminator is doing real work (some rows advanced without sending)",
      rawSent > realSends,
      `${rawSent - realSends} rows advanced with no provider identity`,
    );

    // Every row must resolve to a known status — never a blank cell.
    check("every row resolves to a known outcome", classified.every((c) => typeof c === "string" && c.length > 0));

    // The summary must reconcile with a hand count over the SAME rows.
    const summary = summarizeFailures(runs as never);
    const handFailed = classified.filter((c) => c === "failed").length;
    check("summary.failed matches a hand count", summary.failed === handFailed, `${summary.failed} vs ${handFailed}`);
    check("summary.realSends matches a hand count", summary.realSends === realSends, `${summary.realSends} vs ${realSends}`);
    check(
      "failure rate is over real sends, never over all rows",
      summary.failureRatePct === null ||
        summary.failureRatePct === Math.round((summary.failed / (summary.realSends + summary.failed)) * 100),
      `${summary.failureRatePct}%`,
    );

    // Policy holds must not inflate the failure rate: a working compliance gate
    // reported as an outage trains an operator to ignore the number.
    //
    // Asserted by DIFFERENCE, not by an expression that cannot be false. The
    // first version of this line ended in `|| true`, which is the same
    // worthless reassurance the whole Activity tab exists to remove — written
    // by me, in the harness meant to catch exactly that.
    const heldRows = runs.filter((r) => isHeldForPolicy(r.last_error));
    console.log(`  held by policy (consent / no channel / provider unwired): ${heldRows.length}`);
    const heldClassifiedFailed = heldRows.filter((r) => classifyRunStatus(r as never) === "failed").length;
    check(
      "no policy hold is counted as a failure",
      heldClassifiedFailed === 0,
      `${heldClassifiedFailed} of ${heldRows.length} holds landed in the failure bucket`,
    );

    // The window filter itself must be valid PostgREST, not just plausible.
    const w = outcomeWindow("2026-08-01T00:00:00Z");
    check("the outcome window filter has no whitespace (PostgREST would 400)", !/\s/.test(w));
  }

  // ══ 2. MANAGE TAB — on/off ═══════════════════════════════════════════════
  section("2. Manage tab — enable / disable round trip");
  {
    const read = () =>
      Number(sql<{ enabled: number }>(`select enabled from drip_sequences where id = ${q(SEQ_ID)}`)[0]?.enabled);

    const before = read();
    check("fixture starts DISABLED (nothing can enrol against it)", before === 0, `enabled=${before}`);

    sql(`update drip_sequences set enabled = 1 where id = ${q(SEQ_ID)}`, true);
    check("enable persists", read() === 1);

    sql(`update drip_sequences set enabled = 0 where id = ${q(SEQ_ID)}`, true);
    check("disable persists", read() === 0);

    // libSQL stores booleans as 0/1 — a strict === true anywhere in the read
    // path would render every live sequence as paused.
    const raw = sql<{ enabled: unknown }>(`select enabled from drip_sequences where id = ${q(SEQ_ID)}`)[0]?.enabled;
    check(
      "enabled comes back as a NUMBER on libSQL, so no read path may use === true",
      typeof raw === "number",
      `typeof ${typeof raw}`,
    );

    // And the live sequences the tab lists.
    const live = sql<{ n: number }>(`select count(*) as n from drip_sequences where tenant_id = ${q(TENANT)} and enabled = 1`)[0];
    console.log(`  live sequences the Manage tab should show as ON: ${live?.n}`);
    check("the Manage list has live sequences to toggle", Number(live?.n) > 0);
  }

  // ══ 3. TEMPLATES TAB — the interchange ═══════════════════════════════════
  section("3. Templates tab — changing the template behind a step");
  {
    const pool = fixturePool();
    check("fixture pool loaded", pool.length === 4, `${pool.length} templates`);

    const steps = fixtureSteps();
    const step0 = steps[0]; // role: nudge
    const step1 = steps[1]; // role: opener

    // What the dropdown offers: approved + in-brand + in-stage + IN-ROLE.
    const opts0 = selectableTemplates(pool, { brand: "sunbiz", stage: STAGE, role: effectiveRole(step0.role) });
    check(
      "step 1 (nudge) is offered exactly the two approved nudges",
      opts0.length === 2 && opts0.every((t) => t.role === "nudge"),
      opts0.map((t) => t.id.slice(-2)).join(","),
    );
    check("the RETIRED template is never offered", !opts0.some((t) => t.id === TPL_RETIRED));
    check("an OPENER is not offered to a nudge step", !opts0.some((t) => t.id === TPL_OPENER));

    const opts1 = selectableTemplates(pool, { brand: "sunbiz", stage: STAGE, role: effectiveRole(step1.role) });
    check("step 2 (opener) is offered only the opener", opts1.length === 1 && opts1[0].id === TPL_OPENER);

    // Cross-brand isolation, on real rows.
    check(
      "a Bluerise step is offered no SunBiz copy",
      selectableTemplates(pool, { brand: "bluerise", stage: STAGE, role: "nudge" }).length === 0,
    );

    // The validator, as the PATCH route calls it.
    const trigger = jparse<Record<string, unknown>>(
      sql<{ trigger_filter: string }>(`select trigger_filter from drip_sequences where id = ${q(SEQ_ID)}`)[0]?.trigger_filter,
      {},
    );
    check("brand resolves from the trigger filter", brandFromTriggerFilter(trigger) === "sunbiz");
    check("stage resolves from the trigger filter", stageFromTriggerFilter(trigger) === STAGE);

    const req = {
      sequenceId: SEQ_ID,
      stepIndex: 0,
      fromTemplateId: null,
      toTemplateId: TPL_B,
      actorUserId: "apex-smoke-test",
      brand: "sunbiz" as const,
      stage: STAGE,
      role: effectiveRole(step0.role),
    };
    check("a valid swap is accepted", validateInterchange(pool, req).ok);
    const crossRole = validateInterchange(pool, { ...req, toTemplateId: TPL_OPENER });
    check("a cross-ROLE swap is refused", !crossRole.ok, crossRole.ok ? "" : crossRole.reason.slice(0, 60));
    const retired = validateInterchange(pool, { ...req, toTemplateId: TPL_RETIRED });
    check("a RETIRED swap is refused", !retired.ok, retired.ok ? "" : retired.reason.slice(0, 60));
    check("an unattributable swap is refused", !validateInterchange(pool, { ...req, actorUserId: "" }).ok);

    // ── Apply the swap the way the UI does, and prove the ENGINE honours it ──
    const swapped: DripStep[] = steps.map((s, i) =>
      i === 0 ? { ...s, subject: "POOL B subject", body: "POOL B body text.", template_id: TPL_B } : s,
    );
    sql(`update drip_sequences set steps = ${q(JSON.stringify(swapped))} where id = ${q(SEQ_ID)}`, true);

    const after = fixtureSteps();
    check("the pin survives the parse round trip", after[0].template_id === TPL_B, String(after[0].template_id));

    // The whole point: resolveCopy must return the PINNED template, for every
    // lead, against the same role-scoped pool the executor builds.
    const scoped = poolFor(pool, "sunbiz", STAGE, effectiveRole(after[0].role));
    const picks = ["lead-1", "lead-2", "lead-3", "lead-9", "lead-77"].map(
      (lead) => resolveCopy(after[0], lead, 0, scoped).templateId,
    );
    check("the pinned template is returned for EVERY lead", picks.every((p) => p === TPL_B), picks.join(","));
    check("the pinned BODY is what would send", resolveCopy(after[0], "lead-1", 0, scoped).body === "POOL B body text.");
    check(
      "stale HTML is dropped on a pinned step",
      resolveCopy({ ...after[0], body_html: "<p>OLD</p>" }, "lead-1", 0, scoped).bodyHtml === undefined,
    );

    // PROVE the pin overrode sampling, rather than agreeing with it by luck.
    // Find a lead the hash sends to the OTHER template, then pin it away.
    // (Weight 3 vs 1 means most leads sample TPL_A, so such a lead exists.)
    const probe = Array.from({ length: 60 }, (_, i) => `probe-${i}`);
    const contrary = probe.find(
      (lead) => resolveCopy({ ...after[0], template_id: undefined }, lead, 0, scoped).templateId !== TPL_B,
    );
    check("sampling picks a DIFFERENT template for some lead (so the pin is a real override)", Boolean(contrary), String(contrary));
    if (contrary) {
      const sampled = resolveCopy({ ...after[0], template_id: undefined }, contrary, 0, scoped).templateId;
      const pinned = resolveCopy(after[0], contrary, 0, scoped).templateId;
      check(
        "the pin overrides what sampling would have chosen",
        sampled !== TPL_B && pinned === TPL_B,
        `${contrary}: sampled ${String(sampled).slice(-2)} -> pinned ${String(pinned).slice(-2)}`,
      );
    }

    // A pin the engine cannot reach must NOT send retired copy.
    const badPin = resolveCopy({ ...after[0], template_id: TPL_RETIRED }, "lead-1", 0, scoped);
    check("a pin to retired copy falls back to sampling", badPin.templateId !== TPL_RETIRED && badPin.body !== "POOL RETIRED body.");

    // The audit diff the route writes.
    const changes = diffPins(steps, after);
    check("the swap produces exactly one audit record", changes.length === 1, JSON.stringify(changes));
    check("the audit names from and to", changes[0]?.from === null && changes[0]?.to === TPL_B);

    // Unpin, and confirm THAT is recorded too.
    const unpinned: DripStep[] = after.map((s, i) => (i === 0 ? { ...s, template_id: undefined } : s));
    const unpinChanges = diffPins(after, unpinned);
    check("unpinning is recorded as a change", unpinChanges.length === 1 && unpinChanges[0].to === null);

    // Restore the fixture step so later runs start clean.
    sql(`update drip_sequences set steps = ${q(JSON.stringify(steps))} where id = ${q(SEQ_ID)}`, true);
    check("fixture steps restored", fixtureSteps()[0].template_id === undefined);
  }

  // ══ 4. THE LIVE POOL — is the interchange usable at all? ═════════════════
  section("4. Templates tab — the LIVE pool (not the fixture)");
  {
    const live = sql<{ n: number }>(
      `select count(*) as n from drip_template_pool where tenant_id = ${q(TENANT)} and stage <> ${q(STAGE)} and status = 'approved'`,
    )[0];
    const n = Number(live?.n ?? 0);
    console.log(`  approved templates for REAL stages: ${n}`);
    // Not a failure of the code — the feature is built and inert. But an
    // operator opening Templates today can swap nothing, and that is worth
    // stating plainly rather than discovering later.
    check(
      "NOTE: the live pool is seeded (interchange is usable in production)",
      n > 0,
      n === 0 ? "EMPTY — every step shows 'no approved templates'; the swap UI has nothing to offer" : `${n} approved`,
    );
  }

  // ══ 5. VOLUME TAB — the chart ════════════════════════════════════════════
  section("5. Volume tab — per-sequence daily counts");
  {
    const raw = sql<{ agent_source: string | null; created_at: string | null; metadata: string | null }>(
      `select agent_source, created_at, metadata from lead_interactions
       where tenant_id = ${q(TENANT)} and type='email_sent' and direction='outbound'
       and agent_source like 'sequence:%' and created_at >= datetime('now','-15 days')
       order by created_at desc limit 5000`,
    );
    const rows = raw.map((r) => {
      const md = jparse<Record<string, unknown>>(r.metadata, {});
      return {
        sequenceId: typeof md.sequence_id === "string" && md.sequence_id ? md.sequence_id : null,
        sequenceName: sequenceNameFromSource(r.agent_source),
        at: r.created_at || "",
        dryRun: String(md.dry_run) === "true",
      };
    });
    const nowMs = Date.now();
    const vols = bucketBySequenceDay(rows, { days: 14, timeZone: TZ, nowMs });
    console.log(`  sequences with volume in 14 days: ${vols.length}`);
    for (const v of vols.slice(0, 5)) console.log(`    ${String(v.total).padStart(4)}  today ${v.today}  ${v.sequenceName}`);

    check("the chart has real volume to draw", vols.length > 0);
    check("every sequence has 14 buckets (a ragged axis cannot be compared)", vols.every((v) => v.days.length === 14));
    check("no sequence appears twice (partly-stamped history must merge)",
      new Set(vols.map((v) => v.sequenceName)).size === vols.length,
      vols.map((v) => v.sequenceName).join(" | ").slice(0, 90));

    const inWindow = new Set(
      Array.from({ length: 14 }, (_, i) => dayKey(new Date(nowMs - i * 86_400_000).toISOString(), TZ)),
    );
    const hand = rows.filter((r) => !r.dryRun && (r.sequenceId || r.sequenceName) && inWindow.has(dayKey(r.at, TZ))).length;
    check("bucketed total reconciles with a hand count", vols.reduce((s, v) => s + v.total, 0) === hand,
      `${vols.reduce((s, v) => s + v.total, 0)} vs ${hand}`);

    // The join the page does, against the real sequence list.
    const seqs = sql<{ id: string; name: string; enabled: number; daily_email_cap: number | null }>(
      `select id, name, enabled, daily_email_cap from drip_sequences where tenant_id = ${q(TENANT)}`,
    ).map((s) => ({ id: s.id, name: s.name, enabled: Number(s.enabled) === 1, daily_email_cap: s.daily_email_cap }));
    const joined = joinVolumeToSequences(seqs, vols);
    check("every configured sequence appears, even silent ones", joined.length >= seqs.length, `${joined.length} rows for ${seqs.length} sequences`);
    check("the busiest sequence sorts first", (joined[0]?.volume?.total ?? 0) >= (joined[1]?.volume?.total ?? 0));
    const silent = joined.filter((r) => !r.volume).length;
    console.log(`  sequences that sent NOTHING in 14 days: ${silent}`);
  }

  // ══ 6. VOLUME TAB — changing the cap ═════════════════════════════════════
  section("6. Volume tab — changing the cap, and what the engine does");
  {
    const readCap = () =>
      sql<{ daily_email_cap: number | null }>(`select daily_email_cap from drip_sequences where id = ${q(SEQ_ID)}`)[0]
        ?.daily_email_cap ?? null;

    check("fixture starts UNCAPPED (the shipped default)", readCap() === null);

    // The values the UI can send, through the REAL validator. `capOf` narrows
    // the discriminated union rather than reaching for `.value` on a verdict
    // that may not carry one — tsx strips the types, tsc does not, and CI runs
    // tsc.
    const capOf = (input: unknown): number | null | "REFUSED" => {
      const v = parseSequenceDailyCap(input);
      return v.ok ? v.value : "REFUSED";
    };
    check("empty means no cap", capOf("") === null);
    check("whitespace means no cap, NOT zero", capOf("  ") === null);
    check("0 is a real value (send nothing), not null", capOf("0") === 0);
    check("a negative cap is refused", !parseSequenceDailyCap("-5").ok);
    check("a fractional cap is refused", !parseSequenceDailyCap("2.5").ok);
    check("an absurd cap is refused", !parseSequenceDailyCap("999999").ok);

    // Write 40, read it back through the same column the engine reads.
    sql(`update drip_sequences set daily_email_cap = 40 where id = ${q(SEQ_ID)}`, true);
    check("the cap persists", readCap() === 40, String(readCap()));

    // The DB refuses what the UI refuses — belt and braces.
    let dbRefused = false;
    try {
      sql(`update drip_sequences set daily_email_cap = 99999 where id = ${q(SEQ_ID)}`, true);
    } catch {
      dbRefused = true;
    }
    check("the DB CHECK also refuses an absurd cap", dbRefused && readCap() === 40);

    // ── The gate, with the cap the operator just set ──
    const key = `${TENANT}|${SEQ_ID}`;
    const budget = (sentToday: number, cap: number | null, degraded: string[] = []): EmailBudget => ({
      dailyRemaining: { sunbiz: 100, bluerise: 100 },
      hourlyRemaining: { sunbiz: 100, bluerise: 100 },
      perLeadSent7d: new Map(),
      perLeadCap: 99,
      perSequenceSentToday: new Map([[key, sentToday]]),
      perSequenceCap: cap === null ? new Map() : new Map([[key, cap]]),
      perSequenceDegraded: new Set(degraded),
      degraded: false,
      perLeadDegraded: false,
    });
    const seqRef = { tenantId: TENANT, id: SEQ_ID, name: "ZZ APEX SMOKE TEST — safe to delete" };

    check("under the cap, the send proceeds", emailGateReason(budget(39, 40), "lead-1", "sunbiz", STAGE, seqRef) === null);
    check("AT the cap, the send is held", emailGateReason(budget(40, 40), "lead-1", "sunbiz", STAGE, seqRef) === "sequence_daily_cap");
    check("over the cap, still held", emailGateReason(budget(41, 40), "lead-1", "sunbiz", STAGE, seqRef) === "sequence_daily_cap");
    check("a cap of 0 holds immediately", emailGateReason(budget(0, 0), "lead-1", "sunbiz", STAGE, seqRef) === "sequence_daily_cap");
    check("uncapped never holds", emailGateReason(budget(9999, null), "lead-1", "sunbiz", STAGE, seqRef) === null);

    // Held, not failed — nobody is dropped.
    const hold = Date.parse(holdUntilIso("sequence_daily_cap")) - Date.now();
    check("a capped row is HELD to the next calendar day, not failed", hold > 0 && hold <= 86_400_000, `${Math.round(hold / 3_600_000)}h`);

    // The cap bites WITHIN one dispatch run, not only on the next.
    const b = budget(0, 2);
    consumeEmail(b, "lead-1", "sunbiz", seqRef);
    consumeEmail(b, "lead-2", "sunbiz", seqRef);
    check("two sends exhaust a cap of 2 inside one run", emailGateReason(b, "lead-3", "sunbiz", STAGE, seqRef) === "sequence_daily_cap");

    // A failed read holds only CAPPED sequences, and only that tenant's.
    check(
      "a failed cap read holds a capped sequence",
      emailGateReason(budget(0, 40, [TENANT]), "lead-1", "sunbiz", STAGE, seqRef) === "sequence_budget_unavailable",
    );
    check(
      "a failed cap read does NOT hold an uncapped one",
      emailGateReason(budget(0, null, [TENANT]), "lead-1", "sunbiz", STAGE, seqRef) === null,
    );
    check(
      "another tenant's failed read does not stop this one",
      emailGateReason(budget(0, 40, ["some-other-tenant"]), "lead-1", "sunbiz", STAGE, seqRef) === null,
    );

    // The brand ceiling still wins over a generous per-sequence cap.
    const brandExhausted = { ...budget(0, 999), dailyRemaining: { sunbiz: 0, bluerise: 100 } };
    check("the brand ceiling still wins", emailGateReason(brandExhausted, "lead-1", "sunbiz", STAGE, seqRef) === "daily_cap");

    // What the operator sees in the "left today" column.
    check("remaining is cap minus sent", sequenceRemaining(15, 40) === 25);
    check("remaining never goes negative", sequenceRemaining(50, 40) === 0);
    check("uncapped remaining is UNKNOWN, not zero", sequenceRemaining(50, null) === null);

    // Clear it, and confirm the sequence is uncapped again.
    sql(`update drip_sequences set daily_email_cap = NULL where id = ${q(SEQ_ID)}`, true);
    check("clearing the cap restores uncapped", readCap() === null);
  }

  // ══ 7. NO LIVE SEQUENCE WAS TOUCHED ══════════════════════════════════════
  section("7. Blast radius");
  {
    const capped = sql<{ n: number }>(
      `select count(*) as n from drip_sequences where tenant_id = ${q(TENANT)} and id <> ${q(SEQ_ID)} and daily_email_cap is not null`,
    )[0];
    check("no LIVE sequence gained a cap", Number(capped?.n) === 0, `${capped?.n} capped`);

    const pinned = sql<{ n: number }>(
      `select count(*) as n from drip_sequences where tenant_id = ${q(TENANT)} and id <> ${q(SEQ_ID)} and steps like '%template_id%'`,
    )[0];
    check("no LIVE sequence gained a template pin", Number(pinned?.n) === 0, `${pinned?.n} pinned`);

    const enabled = sql<{ n: number }>(
      `select count(*) as n from drip_sequences where tenant_id = ${q(TENANT)} and enabled = 1`,
    )[0];
    check("the live sequence count is unchanged at 8", Number(enabled?.n) === 8, `${enabled?.n} enabled`);

    const poolLeak = sql<{ n: number }>(
      `select count(*) as n from drip_template_pool where tenant_id = ${q(TENANT)} and stage <> ${q(STAGE)}`,
    )[0];
    check("no pool template was seeded under a REAL stage", Number(poolLeak?.n) === 0, `${poolLeak?.n}`);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log("failing:\n  - " + failures.join("\n  - "));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SUITE ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
