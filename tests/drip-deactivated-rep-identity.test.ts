/**
 * drip-deactivated-rep-identity.test.ts — a deactivated SunBiz rep keeps the
 * leads they worked (history), but a NEW drip is never signed by them, never
 * texted from their line and never lands its replies in their inbox.
 *
 * Before 2026-09-24 nothing in the drip engine read user_profiles.deactivated_at:
 *
 *   - lib/drips/enroller.ts   backfilled rep_name from assigned_to, so a lead
 *                              first enrolled after the rep left started
 *                              carrying their name
 *   - lib/drips/executor.ts   signed every step with rep_name (and the apply
 *                              link with ?rep=<their slug>), and routed the SMS
 *                              through classifyRep onto the rep's own
 *                              TextTorrent sub-account and number
 *
 * Everything runs for real against a local libSQL database: one live enrolment
 * pass, then a DRY-RUN dispatch pass (DRIPS_LIVE unset), which renders, resolves
 * the sender and logs exactly what it would have sent without reaching
 * TextTorrent or Gmail. The one stand-in is the recipient's clock: the TCPA
 * window is forced open so the SMS path does not depend on the hour the test
 * runs at (the recipient's timezone is still resolved for real).
 *
 * Run: node --conditions=react-server --import tsx tests/drip-deactivated-rep-identity.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "drip-deactivated-rep-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
// Nothing in the developer's shell may steer the engine: no live flag, no
// number or identity override, no stage routing, no provider credentials.
for (const key of Object.keys(process.env)) {
  if (/^(DRIP|ACCELERATED_|BRAVO_FORCE|LIVE_SEND|TEXTTORRENT|GOOGLE_|BRIDGE_|TELEGRAM|SUNBIZ_)/.test(key)) {
    delete process.env[key];
  }
}
// Email's daytime window is read at module load; open it for the whole day.
process.env.DRIP_EMAIL_WINDOW_START = "0";
process.env.DRIP_EMAIL_WINDOW_END = "24";

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

let standingReads = 0;

/** Installed before the drip modules load, so they bind to these. */
async function installStubs() {
  // The recipient's clock. Timezone resolution stays real; only "is it daytime
  // there right now" is pinned open.
  const realTcpa = await import("../lib/tcpa-window");
  stubModule(require.resolve("../lib/tcpa-window"), {
    ...realTcpa,
    checkTcpaWindow: (phone: string | null | undefined, at?: Date) => ({
      ...realTcpa.checkTcpaWindow(phone, at),
      withinWindow: true,
    }),
  });

  // Count standing reads, so the per-pass cache is proven rather than assumed.
  const realTeam = await import("../lib/team");
  stubModule(require.resolve("../lib/team"), {
    ...realTeam,
    memberStanding: async (tenantId: string, authUserId: string) => {
      standingReads += 1;
      return realTeam.memberStanding(tenantId, authUserId);
    },
  });
}

const TENANT = "8a8a8a8a-0000-4000-8000-00000000008a"; // SunBiz ("submissions")
const OTHER_TENANT = "8b8b8b8b-0000-4000-8000-00000000008b";
const ALEX = "0f0f0f0f-0000-4000-8000-000000000003"; // active
const JORDAN = "0f0f0f0f-0000-4000-8000-000000000004"; // deactivated here, and only here
const JOE = "0f0f0f0f-0000-4000-8000-000000000005"; // deactivated here, ACTIVE on another tenant
const RETIRED_AT = "2026-09-24T12:00:00Z";

const SMS_SEQ = "5e5e5e5e-0000-4000-8000-000000000001";
const EMAIL_SEQ = "5e5e5e5e-0000-4000-8000-000000000002";
const LATE_SEQ = "5e5e5e5e-0000-4000-8000-000000000003";

const L_ALEX = "1e1e1e1e-0000-4000-8000-000000000001"; // active rep, rep_name not yet backfilled
const L_JORDAN_NEW = "1e1e1e1e-0000-4000-8000-000000000002"; // retired rep, rep_name not yet backfilled
const L_JORDAN_OLD = "1e1e1e1e-0000-4000-8000-000000000003"; // retired rep, signed + texted before they left
const L_JOE = "1e1e1e1e-0000-4000-8000-000000000004"; // retired here, active elsewhere

const ALEX_LINE = "+17857910696";
const JORDAN_LINE = "+13106271134";
const JOE_LINE = "+14707908565";
const SHARED_LINE = "+18604071050"; // the parent/admin account's line

const SMS_BODY = "Hi {{lead.first_name}}, {{lead.rep_name}} here at SunBiz. Pick your application back up: {{lead.application_url}}";
const EMAIL_BODY = "Hi {{lead.first_name}},\n\nChecking in on {{lead.business_name}}.\n\n- {{lead.rep_name}}, SunBiz Funding";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Run fn with console.warn captured and console.error silenced. */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: unknown[][] }> {
  const warned: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
  console.error = () => undefined;
  try {
    return { result: await fn(), warned };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}
const tagged = (warned: unknown[][], tag: string) => warned.filter((args) => args[0] === tag);

async function main() {
  await installStubs();
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  const ID_SQL = "(lower(hex(randomblob(16))))";
  await seed.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, invited_by TEXT,
      joined_at TEXT, manager_user_id TEXT, updated_at TEXT, custom_fields TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_by TEXT, created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE drip_sequences (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, enabled INTEGER,
      trigger_filter TEXT, steps TEXT, email_class TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE drip_runs (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, lead_id TEXT,
      sequence_id TEXT, sequence_name TEXT, step_index INTEGER, channel TEXT, scheduled_for TEXT,
      status TEXT, attempts INTEGER DEFAULT 0, claimed_at TEXT, sent_at TEXT, from_identity TEXT,
      last_error TEXT, provider_message_id TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, lead_id TEXT,
      type TEXT, channel TEXT, direction TEXT, agent_source TEXT, to_phone TEXT, to_email TEXT,
      from_phone TEXT, subject TEXT, content TEXT, content_preview TEXT, actor_user_id TEXT,
      metadata TEXT, sent_at TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT, phone_last10 TEXT);
    CREATE TABLE email_suppressions (tenant_id TEXT, email TEXT);
    CREATE TABLE sms_destination_health (tenant_id TEXT, phone_last10 TEXT, delivered INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0, textable INTEGER, verified INTEGER, reason TEXT,
      PRIMARY KEY (tenant_id, phone_last10));
    CREATE TABLE sms_sender_numbers (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, number TEXT,
      rep_key TEXT, active INTEGER, last_seen_at TEXT);
    CREATE TABLE drip_template_pool (id TEXT PRIMARY KEY, tenant_id TEXT, brand TEXT, stage TEXT, role TEXT,
      subject TEXT, body_text TEXT, status TEXT, weight INTEGER);
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
  `);

  const profile = (
    id: string, tenantId: string, authId: string, email: string, name: string, deactivatedAt: string | null,
  ) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name,
            onboarding_completed_at, joined_at, updated_at, deactivated_at)
          VALUES (?, ?, ?, ?, 'agent', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?)`,
    args: [id, authId, email, tenantId, name, deactivatedAt],
  });
  const lead = (id: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at) VALUES (?, ?, 'lead', ?, '2026-09-01T00:00:00Z')",
    args: [id, TENANT, JSON.stringify({ stage: "sent_application", sending_brand: "sunbiz", ...data })],
  });
  const sequence = (id: string, name: string, channel: "sms" | "email", body: string) => ({
    sql: `INSERT INTO drip_sequences (id, tenant_id, name, enabled, trigger_filter, steps, email_class)
          VALUES (?, ?, ?, 1, ?, ?, 'transactional')`,
    args: [
      id, TENANT, name,
      JSON.stringify({ entity: "lead", field: "stage", to: "sent_application" }),
      JSON.stringify([{ channel, delay_minutes: 0, subject: "Your SunBiz application", body }]),
    ],
  });
  const line = (number: string, repKey: string) => ({
    sql: "INSERT INTO sms_sender_numbers (tenant_id, number, rep_key, active, last_seen_at) VALUES (?, ?, ?, 1, '2026-09-20T00:00:00Z')",
    args: [TENANT, number, repKey],
  });
  await seed.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'Sun Biz Funding')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'elsewhere', 'Elsewhere')", args: [OTHER_TENANT] },
      profile("p-alex", TENANT, ALEX, "alex@sunbizfunding.com", "Alex Active", null),
      profile("p-jordan", TENANT, JORDAN, "jordan@sunbizfunding.com", "Jordan Retired", RETIRED_AT),
      profile("p-joe", TENANT, JOE, "joe@sunbizfunding.com", "Joe Gone", RETIRED_AT),
      // Joe still works on another tenant. Standing is tenant-scoped, so that
      // row must never make him an active signer here.
      profile("p-joe-other", OTHER_TENANT, JOE, "joe@other.test", "Joe Elsewhere", null),
      lead(L_ALEX, {
        contact_name: "Dana Merchant", business_name: "Alex Rep Co", phone: "+13055550101",
        email: "dana@merchant.test", assigned_to: ALEX,
      }),
      lead(L_JORDAN_NEW, {
        contact_name: "Riley Merchant", business_name: "New Retired Co", phone: "+13055550102",
        email: "riley@merchant.test", assigned_to: JORDAN,
      }),
      lead(L_JORDAN_OLD, {
        contact_name: "Morgan Merchant", business_name: "Old Retired Co", phone: "+13055550103",
        email: "morgan@merchant.test", assigned_to: JORDAN, rep_name: "Jordan Retired",
      }),
      lead(L_JOE, {
        contact_name: "Casey Merchant", business_name: "Casey Trucking", phone: "+13055550104",
        email: "casey@merchant.test", assigned_to: JOE, rep_name: "Joe Gone",
      }),
      sequence(SMS_SEQ, "Application SMS", "sms", SMS_BODY),
      sequence(EMAIL_SEQ, "Application Email", "email", EMAIL_BODY),
      line(ALEX_LINE, "alex"),
      line(JORDAN_LINE, "jordan"),
      line(JOE_LINE, "joe"),
      line(SHARED_LINE, "admin"),
      // Jordan texted this merchant from his own line before he left. Line
      // continuity must not carry a retired rep's conversation on his number.
      {
        sql: `INSERT INTO drip_runs (tenant_id, lead_id, sequence_id, sequence_name, step_index, channel,
                scheduled_for, status, sent_at, from_identity, created_at)
              VALUES (?, ?, 'old-seq', 'Old SMS', 0, 'sms', '2026-08-01T00:00:00Z', 'done',
                '2026-08-01T00:00:00Z', ?, '2026-08-01T00:00:00Z')`,
        args: [TENANT, L_JORDAN_OLD, `jordan:${JORDAN_LINE}`],
      },
    ],
    "write",
  );

  const leadData = async (id: string): Promise<Record<string, unknown>> => {
    const r = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] });
    return JSON.parse(String(r.rows[0].data));
  };

  // ── 1. Enrolment: the rep_name backfill ───────────────────────────────────
  const { runEnrollDrips } = await import("../lib/drips/enroller");
  process.env.DRIPS_LIVE = "1";
  process.env.DRIPS_ENROLL_STAGES = "sent_application";
  standingReads = 0;
  const enrol = await captureWarn(() => runEnrollDrips());
  delete process.env.DRIPS_LIVE;
  delete process.env.DRIPS_ENROLL_STAGES;

  await check("enrol: every lead enters both sequences (the rep's standing gates the signature, not the funnel)", () => {
    assert.equal(enrol.result.totals.enrolled, 8, JSON.stringify(enrol.result.perSequence.map((s) => s.error ?? s.skipped)));
  });

  await check("enrol: an active rep's name is still backfilled onto their lead, unchanged", async () => {
    const d = await leadData(L_ALEX);
    assert.equal(d.rep_name, "Alex Active");
    assert.equal(d.assigned_to, ALEX);
  });

  await check("enrol: a deactivated rep's name is NOT backfilled; the lead stays theirs", async () => {
    const d = await leadData(L_JORDAN_NEW);
    assert.equal(d.rep_name, undefined, "a retired teammate must not be written into the live signature");
    assert.equal(d.assigned_to, JORDAN, "ownership is history and is kept");
  });

  await check("enrol: one standing read per rep for the whole pass", () => {
    // Only the two leads missing rep_name ask (Alex, Jordan), once per rep even
    // though each is enrolled into two sequences.
    assert.equal(standingReads, 2);
  });

  // ── 2. Dispatch (dry run): signer, apply link, sending line ───────────────
  await seed.execute("UPDATE drip_runs SET scheduled_for = '2026-09-01T00:00:00Z' WHERE status = 'scheduled'");
  const { runDispatchDrips, buildContext } = await import("../lib/drips/executor");
  const { renderTemplate } = await import("../lib/drips/templates");
  standingReads = 0;
  const dispatch = await captureWarn(() => runDispatchDrips());

  type Sent = { content: string; subject: string | null; meta: Record<string, unknown> };
  const sent = async (leadId: string, channel: "sms" | "email"): Promise<Sent[]> => {
    const r = await seed.execute({
      sql: "SELECT content, content_preview, subject, metadata FROM lead_interactions WHERE lead_id = ? AND channel = ? ORDER BY created_at",
      args: [leadId, channel],
    });
    return r.rows.map((row) => ({
      content: String(channel === "email" ? row.content : row.content_preview),
      subject: row.subject == null ? null : String(row.subject),
      meta: JSON.parse(String(row.metadata)),
    }));
  };
  const fromIdentity = async (leadId: string, sequenceId: string) => {
    const r = await seed.execute({
      sql: "SELECT from_identity, status FROM drip_runs WHERE lead_id = ? AND sequence_id = ?",
      args: [leadId, sequenceId],
    });
    return { from: String(r.rows[0].from_identity), status: String(r.rows[0].status) };
  };
  /** What the engine renders for a lead with NO rep at all — the generic lane. */
  const unassigned = (d: Record<string, unknown>) => ({
    ...d, rep_name: undefined, assigned_agent_name: undefined, assigned_to: undefined,
  });

  await check("dispatch: every row ran as a dry run", () => {
    assert.equal(dispatch.result.claimed, 8);
    assert.equal(dispatch.result.dryRun, 8, JSON.stringify(dispatch.result));
  });

  await check("dispatch: one standing read per rep for the whole batch", () => {
    // 8 rows across three reps (Alex, Jordan, Joe).
    assert.equal(standingReads, 3);
  });

  await check("active rep SMS: signer, apply link and sending line are exactly today's", async () => {
    const stored = await leadData(L_ALEX);
    const [sms] = await sent(L_ALEX, "sms");
    assert.equal(sms.content, renderTemplate(SMS_BODY, buildContext(stored, "sms")), "byte-identical render");
    assert.match(sms.content, /^Hi Dana, Alex Active here at SunBiz\. /);
    assert.match(sms.content, /\/f\/submissions\/initial-lead-capture\?rep=alex(&|$)/);
    assert.equal(sms.meta.rep, "alex");
    assert.equal(sms.meta.act_as, "alex@sunbizfunding.com", "sent as Alex's own sub-account");
    assert.equal(sms.meta.from_number, ALEX_LINE);
    assert.deepEqual(await fromIdentity(L_ALEX, SMS_SEQ), { from: `dry:alex:${ALEX_LINE}`, status: "done" });
  });

  await check("active rep email: still signed by the rep", async () => {
    const [email] = await sent(L_ALEX, "email");
    assert.match(email.content, /\n- Alex Active, SunBiz Funding$/);
    assert.equal(email.content, renderTemplate(EMAIL_BODY, buildContext(await leadData(L_ALEX), "email")));
  });

  for (const [label, leadId] of [
    ["deactivated rep (never backfilled)", L_JORDAN_NEW],
    ["deactivated rep (rep_name stored before they left)", L_JORDAN_OLD],
    ["rep deactivated here but active on another tenant", L_JOE],
  ] as const) {
    await check(`${label} SMS: generic signer and apply link`, async () => {
      const stored = await leadData(leadId);
      const [sms] = await sent(leadId, "sms");
      assert.equal(sms.content, renderTemplate(SMS_BODY, buildContext(unassigned(stored), "sms")), "the no-rep render");
      assert.match(sms.content, /, your funding specialist here at SunBiz\. /);
      assert.doesNotMatch(sms.content, /Jordan|Joe/);
      // The existing no-rep slug: the first word of the generic signer.
      assert.match(sms.content, /\/f\/submissions\/initial-lead-capture\?rep=your(&|$)/);
    });

    await check(`${label} SMS: sent as the parent account on the tenant's shared line`, async () => {
      const [sms] = await sent(leadId, "sms");
      assert.equal(sms.meta.rep, "admin");
      assert.equal(sms.meta.act_as, null, "the parent account, not the retired rep's sub-account");
      assert.equal(sms.meta.from_number, SHARED_LINE);
      assert.deepEqual(await fromIdentity(leadId, SMS_SEQ), { from: `dry:admin:${SHARED_LINE}`, status: "done" });
    });

    await check(`${label} email: signed by the generic identity`, async () => {
      const [email] = await sent(leadId, "email");
      assert.match(email.content, /\n- your funding specialist, SunBiz Funding$/);
      assert.doesNotMatch(email.content, /Jordan|Joe/);
    });
  }

  await check("history is kept: the retired rep's stored name and ownership survive dispatch", async () => {
    const d = await leadData(L_JORDAN_OLD);
    assert.equal(d.rep_name, "Jordan Retired");
    assert.equal(d.assigned_to, JORDAN);
    assert.equal((await leadData(L_JOE)).rep_name, "Joe Gone");
  });

  await check("dispatch: a clean pass raises no standing warning", () => {
    assert.equal(tagged(dispatch.warned, "[drips] rep standing unavailable").length, 0);
  });

  // ── 3. Read error: SunBiz keeps sending exactly as today, and says so ─────
  await seed.batch(
    [
      sequence(LATE_SEQ, "Late SMS", "sms", SMS_BODY),
      {
        sql: `INSERT INTO drip_runs (tenant_id, lead_id, sequence_id, sequence_name, step_index, channel,
                scheduled_for, status)
              VALUES (?, ?, ?, 'Late SMS', 0, 'sms', '2026-09-01T00:00:00Z', 'scheduled')`,
        args: [TENANT, L_JORDAN_OLD, LATE_SEQ],
      },
      // Make the standing read fail for this pass only.
      "ALTER TABLE user_profiles RENAME TO user_profiles_unreadable",
    ],
    "write",
  );
  const blip = await captureWarn(() => runDispatchDrips());
  await seed.execute("ALTER TABLE user_profiles_unreadable RENAME TO user_profiles");

  await check("read error: the row still goes out, with today's rep identity (treated as active)", async () => {
    assert.equal(blip.result.dryRun, 1, JSON.stringify(blip.result));
    const rows = await sent(L_JORDAN_OLD, "sms");
    const late = rows[rows.length - 1];
    assert.equal(late.meta.sequence_id, LATE_SEQ);
    assert.match(late.content, /^Hi Morgan, Jordan Retired here at SunBiz\. /);
    assert.equal(late.meta.rep, "jordan");
    assert.equal(late.meta.from_number, JORDAN_LINE);
  });

  await check("read error: the fallback is logged under the drips tag", () => {
    const warns = tagged(blip.warned, "[drips] rep standing unavailable");
    assert.equal(warns.length, 1);
    const detail = warns[0][1] as { tenantId?: string; assignedTo?: string; error?: string };
    assert.equal(detail.tenantId, TENANT);
    assert.equal(detail.assignedTo, JORDAN);
    assert.ok(detail.error, "the underlying error is carried");
  });

  if (failures) {
    console.error(`drip deactivated-rep identity: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("drip deactivated-rep identity: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
