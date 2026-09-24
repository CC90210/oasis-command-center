/**
 * kixie-deactivated-rep-automations.test.ts — a deactivated SunBiz rep whose
 * Kixie line still rings keeps the call attribution (history), but the
 * webhook's automations never hand them NEW work or send in their name.
 *
 *   lib/integrations/kixie-attribution.ts  resolveRepByEmail reports isActive,
 *                                          prefers an active row among duplicate
 *                                          profiles, and warns on a read error
 *   POST /api/webhooks/kixie               keeps the rep on lead_interactions but
 *                                          passes only an ACTIVE rep to:
 *     handleVoicemailFollowup              the "it's <rep>" SMS from their line
 *     handleMissedInbound                  a callback appointment assigned to them
 *     handleDispositionActions             a callback appointment assigned to them
 *
 * Everything runs for real against a local libSQL database. The one stand-in is
 * the TextTorrent sender resolver (it reads encrypted credential stores), which
 * records who it was asked about and answers with a per-rep line.
 *
 * Run: node --conditions=react-server --import tsx tests/kixie-deactivated-rep-automations.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "kixie-deactivated-rep-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
const KIXIE_TOKEN = "test-only-kixie-webhook-token";
process.env.KIXIE_WEBHOOK_SECRET = KIXIE_TOKEN;

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

const senderAsks: Array<string | null> = [];
stubModule(require.resolve("../lib/integrations/texttorrent-sender"), {
  resolveTextTorrentSenderId: async (args: { tenantId: string; userId?: string | null }) => {
    senderAsks.push(args.userId ?? null);
    return args.userId ? `line-of:${args.userId}` : undefined;
  },
});

const TENANT = "4a4a4a4a-0000-4000-8000-00000000004a"; // SunBiz ("submissions")
const OTHER_TENANT = "4b4b4b4b-0000-4000-8000-00000000004b"; // OASIS
const BUSINESS_ID = 4242;
const ACTIVE = "0a0a0a0a-0000-4000-8000-000000000001"; // alex@
const RETIRED = "0a0a0a0a-0000-4000-8000-000000000002"; // jordan@
const DUP_RETIRED = "0a0a0a0a-0000-4000-8000-000000000003"; // dana@, an old deactivated profile
const DUP_ACTIVE = "0a0a0a0a-0000-4000-8000-000000000004"; // dana@, her live profile
const SAM = "0a0a0a0a-0000-4000-8000-000000000005"; // sam@, two profiles, both deactivated
const RETIRED_AT = "2026-09-24T12:00:00Z";
const REP_LINE = "+13055559000";

const LEADS = {
  vmActive: ["5a5a5a5a-0000-4000-8000-000000000001", "3055550101"],
  vmRetired: ["5a5a5a5a-0000-4000-8000-000000000002", "3055550102"],
  missActive: ["5a5a5a5a-0000-4000-8000-000000000003", "3055550103"],
  missRetired: ["5a5a5a5a-0000-4000-8000-000000000004", "3055550104"],
  dispoActive: ["5a5a5a5a-0000-4000-8000-000000000005", "3055550105"],
  dispoRetired: ["5a5a5a5a-0000-4000-8000-000000000006", "3055550106"],
  vmDuplicate: ["5a5a5a5a-0000-4000-8000-000000000007", "3055550107"],
  vmReadError: ["5a5a5a5a-0000-4000-8000-000000000008", "3055550108"],
} as const;

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
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
const tagged = (warned: unknown[][], tag: string) =>
  warned.find((args) => args[0] === tag) as [string, Record<string, unknown>] | undefined;
const DEACTIVATED_TAG = "[webhooks.kixie] rep deactivated; automation skipped";
const READ_ERROR_TAG = "[kixie-attribution] rep lookup failed";

type WebhookBody = {
  ok?: boolean;
  error?: string;
  event_type?: string;
  attributed?: boolean;
  automations?: Array<{ action: string; ok: boolean; detail?: string }>;
};

async function main() {
  console.log("kixie-deactivated-rep-automations:");
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      full_name TEXT, display_name TEXT, joined_at TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT, created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT, agent_source TEXT,
      provider TEXT, provider_message_id TEXT, actor_user_id TEXT, from_phone TEXT, to_phone TEXT,
      content TEXT, content_preview TEXT, kixie_call_id TEXT UNIQUE, call_duration_sec INTEGER,
      recording_url TEXT, transcript_url TEXT, disposition TEXT, call_outcome TEXT, metadata TEXT,
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT,
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE call_appointments (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, entity_type TEXT, scheduled_for TEXT, assigned_to TEXT,
      pre_call_note TEXT, created_by TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE scheduled_sends (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, thread_key TEXT, channel TEXT, to_phone TEXT, body TEXT,
      actor_user_id TEXT, from_identity TEXT, scheduled_for TEXT, status TEXT,
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE drip_runs (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, status TEXT, last_error TEXT);
  `);

  const profile = (id: string, tenantId: string, authId: string, email: string, name: string, deactivatedAt?: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at, deactivated_at)
          VALUES (?, ?, ?, ?, 'agent', ?, '2026-09-01T00:00:00Z', ?)`,
    args: [id, authId, email, tenantId, name, deactivatedAt ?? null],
  });
  const lead = ([id, phone]: readonly [string, string]) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, TENANT, JSON.stringify({ business_name: `Merchant ${id.slice(-2)}`, contact_name: "Pat Merchant", phone, stage: "contacted" })],
  });
  await seed.batch(
    [
      {
        sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'submissions', 'Sun Biz Funding', ?)",
        args: [TENANT, JSON.stringify({ kixie_business_id: String(BUSINESS_ID) })],
      },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis', 'OASIS')", args: [OTHER_TENANT] },
      profile("p-alex", TENANT, ACTIVE, "alex@sunbizfunding.com", "Alex Active"),
      profile("p-jordan", TENANT, RETIRED, "jordan@sunbizfunding.com", "Jordan Retired", RETIRED_AT),
      // The retired rep is still active on the other tenant with the SAME
      // address. The lookup is tenant-scoped, so this row must never make them
      // live on SunBiz.
      profile("p-jordan-other", OTHER_TENANT, RETIRED, "jordan@sunbizfunding.com", "Jordan Elsewhere"),
      // Pre-cutover profile debt: two rows share dana@. The deactivated one sorts
      // first by id, so "first row wins" would pick it.
      profile("p-dana-a", TENANT, DUP_RETIRED, "dana@sunbizfunding.com", "Dana Old", RETIRED_AT),
      profile("p-dana-b", TENANT, DUP_ACTIVE, "dana@sunbizfunding.com", "Dana Duplicate"),
      profile("p-sam-a", TENANT, SAM, "sam@sunbizfunding.com", "Sam Gone", RETIRED_AT),
      profile("p-sam-b", TENANT, SAM, "sam@sunbizfunding.com", "Sam Gone", RETIRED_AT),
      ...Object.values(LEADS).map(lead),
      {
        sql: "INSERT INTO drip_runs (id, tenant_id, lead_id, status) VALUES ('run-active', ?, ?, 'scheduled'), ('run-retired', ?, ?, 'scheduled')",
        args: [TENANT, LEADS.dispoActive[0], TENANT, LEADS.dispoRetired[0]],
      },
    ],
    "write",
  );

  const rows = async (sql: string, args: Array<string | number | null>) =>
    (await seed.execute({ sql, args })).rows as unknown as Array<Record<string, unknown>>;
  const interaction = async (callId: string) =>
    (await rows("SELECT actor_user_id, lead_id, metadata FROM lead_interactions WHERE kixie_call_id = ?", [callId]))[0];
  const sendsFor = (leadId: string) =>
    rows("SELECT actor_user_id, from_identity, body, to_phone, status FROM scheduled_sends WHERE lead_id = ?", [leadId]);
  const appointmentsFor = (leadId: string) =>
    rows("SELECT assigned_to, created_by, pre_call_note FROM call_appointments WHERE lead_id = ?", [leadId]);

  const { NextRequest } = await import("next/server");
  const webhook = await import("../app/api/webhooks/kixie/route");
  const post = async (evt: Record<string, unknown>) => {
    senderAsks.length = 0;
    const req = new NextRequest("http://localhost/api/webhooks/kixie", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kixie-token": KIXIE_TOKEN },
      body: JSON.stringify({ businessid: BUSINESS_ID, ...evt }),
    });
    const { result: res, warned } = await captureWarn(() => webhook.POST(req));
    return { status: res.status, body: (await res.json()) as WebhookBody, warned };
  };
  const outboundVoicemail = (callid: string, merchant: string, email: string) =>
    post({ eventname: "voicemail", callid, calltype: "outgoing", fromnumber: REP_LINE, tonumber: `+1${merchant}`, email });
  const inboundMissed = (callid: string, merchant: string, email: string) =>
    post({
      eventname: "endcall", callid, calltype: "incoming", fromnumber: `+1${merchant}`, tonumber: REP_LINE,
      callstatus: "missed", duration: 0, email,
    });
  const callbackDisposition = (callid: string, merchant: string, email: string) =>
    post({ eventname: "disposition", callid, calltype: "outgoing", fromnumber: REP_LINE, tonumber: `+1${merchant}`, disposition: "Call Back", email });

  // ── resolveRepByEmail ─────────────────────────────────────────────────────
  const { resolveRepByEmail } = await import("../lib/integrations/kixie-attribution");

  await check("resolve: an active rep resolves as before, flagged active", async () => {
    assert.deepEqual(await resolveRepByEmail(TENANT, "Alex@SunBizFunding.com"), {
      userId: ACTIVE,
      email: "alex@sunbizfunding.com",
      displayName: "Alex Active",
      isActive: true,
    });
  });

  await check("resolve: a deactivated rep still resolves (history) but is flagged inactive", async () => {
    assert.deepEqual(await resolveRepByEmail(TENANT, "jordan@sunbizfunding.com"), {
      userId: RETIRED,
      email: "jordan@sunbizfunding.com",
      displayName: "Jordan Retired",
      isActive: false,
    });
  });

  await check("resolve: duplicate profiles prefer the active row instead of failing", async () => {
    const rep = await resolveRepByEmail(TENANT, "dana@sunbizfunding.com");
    assert.equal(rep?.userId, DUP_ACTIVE, "a duplicate address must not drop the rep, nor pick the retired row");
    assert.equal(rep?.displayName, "Dana Duplicate");
    assert.equal(rep?.isActive, true);
  });

  await check("resolve: duplicate profiles that are all deactivated resolve as inactive", async () => {
    const rep = await resolveRepByEmail(TENANT, "sam@sunbizfunding.com");
    assert.equal(rep?.userId, SAM);
    assert.equal(rep?.isActive, false);
  });

  await check("resolve: an address with no profile on this tenant is null", async () => {
    assert.equal(await resolveRepByEmail(OTHER_TENANT, "alex@sunbizfunding.com"), null);
    assert.equal(await resolveRepByEmail(TENANT, "nobody@sunbizfunding.com"), null);
  });

  // ── voicemail follow-up SMS ───────────────────────────────────────────────
  await check("voicemail: an active rep's follow-up SMS is scheduled from their line and signed by them, unchanged", async () => {
    const [leadId, phone] = LEADS.vmActive;
    const { status, body, warned } = await outboundVoicemail("call-vm-active", phone, "alex@sunbizfunding.com");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, {
      ok: true,
      event_type: "BRAVO_KIXIE_VOICEMAIL",
      attributed: true,
      automations: [{ action: "voicemail_followup", ok: true, detail: "sms_scheduled_plus_3m" }],
    });
    const sends = await sendsFor(leadId);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].actor_user_id, ACTIVE);
    assert.equal(sends[0].from_identity, `line-of:${ACTIVE}`);
    assert.equal(sends[0].to_phone, `+1${phone}`);
    assert.equal(
      sends[0].body,
      "Hi Pat, it's Alex Active with SunBiz Funding. Just left you a voicemail about your file. Text or call me back here when you have a minute.",
    );
    assert.equal((await interaction("call-vm-active")).actor_user_id, ACTIVE);
    assert.equal(tagged(warned, DEACTIVATED_TAG), undefined);
  });

  await check("voicemail: a deactivated rep's call is still attributed to them, but no SMS goes out in their name", async () => {
    const [leadId, phone] = LEADS.vmRetired;
    const { status, body, warned } = await outboundVoicemail("call-vm-retired", phone, "Jordan@SunBizFunding.com");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.automations, [{ action: "voicemail_followup", ok: false, detail: "no_rep_resolved" }]);
    assert.deepEqual(await sendsFor(leadId), [], "an SMS signed by a deactivated rep was scheduled");
    assert.deepEqual(senderAsks, [], "a deactivated rep's line was looked up to send from");
    const row = await interaction("call-vm-retired");
    assert.equal(row.lead_id, leadId);
    assert.equal(row.actor_user_id, RETIRED, "the call is history and keeps its rep");
    assert.equal(JSON.parse(String(row.metadata)).kixie_agent_email, "Jordan@SunBizFunding.com");
    const tag = tagged(warned, DEACTIVATED_TAG);
    assert.ok(tag, "skipping the retired rep must be visible in the logs");
    assert.equal(tag[1].userId, RETIRED);
    assert.equal(tag[1].tenantId, TENANT);
  });

  await check("voicemail: duplicate profiles resolve to the live one, which signs the SMS", async () => {
    const [leadId, phone] = LEADS.vmDuplicate;
    const { status, body } = await outboundVoicemail("call-vm-dup", phone, "dana@sunbizfunding.com");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.automations, [{ action: "voicemail_followup", ok: true, detail: "sms_scheduled_plus_3m" }]);
    const sends = await sendsFor(leadId);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].actor_user_id, DUP_ACTIVE);
    assert.match(String(sends[0].body), /it's Dana Duplicate with SunBiz Funding/);
    assert.equal((await interaction("call-vm-dup")).actor_user_id, DUP_ACTIVE);
  });

  // ── missed inbound → callback appointment ─────────────────────────────────
  await check("missed inbound: an active rep gets the callback appointment, unchanged", async () => {
    const [leadId, phone] = LEADS.missActive;
    const { status, body, warned } = await inboundMissed("call-miss-active", phone, "alex@sunbizfunding.com");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.automations, [{ action: "missed_inbound", ok: true, detail: "callback_appointment_30m" }]);
    assert.deepEqual(await appointmentsFor(leadId), [
      { assigned_to: ACTIVE, created_by: ACTIVE, pre_call_note: "Missed inbound call — call back." },
    ]);
    assert.equal((await interaction("call-miss-active")).actor_user_id, ACTIVE);
    assert.equal(tagged(warned, DEACTIVATED_TAG), undefined);
  });

  await check("missed inbound: a deactivated rep's line ringing creates no callback for them; the feed alert still fires", async () => {
    const [leadId, phone] = LEADS.missRetired;
    const { status, body, warned } = await inboundMissed("call-miss-retired", phone, "jordan@sunbizfunding.com");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.automations, [{ action: "missed_inbound", ok: true, detail: "no_rep_for_appointment" }]);
    assert.deepEqual(await appointmentsFor(leadId), [], "new work was assigned to a deactivated rep");
    const alerts = await rows(
      "SELECT id FROM agent_events WHERE event_type = 'BRAVO_KIXIE_MISSED_INBOUND' AND json_extract(payload, '$.call_id') = ?",
      ["call-miss-retired"],
    );
    assert.equal(alerts.length, 1, "the missed call must still reach the team through the feed");
    assert.equal((await interaction("call-miss-retired")).actor_user_id, RETIRED);
    assert.ok(tagged(warned, DEACTIVATED_TAG));
  });

  // ── disposition → callback appointment ────────────────────────────────────
  await check("disposition: an active rep's callback is booked to them and drips pause, unchanged", async () => {
    const [leadId, phone] = LEADS.dispoActive;
    const { status, body } = await callbackDisposition("call-dispo-active", phone, "alex@sunbizfunding.com");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.automations, [{ action: "disposition_action", ok: true, detail: "callback:drips_paused=1" }]);
    assert.deepEqual(await appointmentsFor(leadId), [
      { assigned_to: ACTIVE, created_by: ACTIVE, pre_call_note: 'Kixie disposition "call back" — follow up.' },
    ]);
  });

  await check("disposition: a deactivated rep gets no callback; the drip pause still happens", async () => {
    const [leadId, phone] = LEADS.dispoRetired;
    const { status, body } = await callbackDisposition("call-dispo-retired", phone, "jordan@sunbizfunding.com");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.automations, [{ action: "disposition_action", ok: true, detail: "callback:drips_paused=1" }]);
    assert.deepEqual(await appointmentsFor(leadId), [], "new work was assigned to a deactivated rep");
    const run = (await rows("SELECT status FROM drip_runs WHERE id = 'run-retired'", []))[0];
    assert.equal(run.status, "cancelled");
    assert.equal((await interaction("call-dispo-retired")).actor_user_id, RETIRED);
  });

  await check("no call appointment anywhere is assigned to a deactivated teammate", async () => {
    const retired = await rows(
      "SELECT id FROM call_appointments WHERE assigned_to IN (?, ?, ?)",
      [RETIRED, DUP_RETIRED, SAM],
    );
    assert.deepEqual(retired, []);
  });

  // ── read error: today's behaviour, and visible ────────────────────────────
  await check("read error: the call still lands and the webhook stays 200 with today's no-rep path, and it is logged", async () => {
    const [leadId, phone] = LEADS.vmReadError;
    await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    try {
      const { status, body, warned } = await outboundVoicemail("call-vm-readerror", phone, "alex@sunbizfunding.com");
      assert.equal(status, 200, `a standing read hiccup broke the SunBiz webhook: ${JSON.stringify(body)}`);
      assert.deepEqual(body.automations, [{ action: "voicemail_followup", ok: false, detail: "no_rep_resolved" }]);
      assert.deepEqual(await sendsFor(leadId), []);
      const row = await interaction("call-vm-readerror");
      assert.equal(row.lead_id, leadId, "the call row is the ledger and must still land");
      assert.equal(row.actor_user_id, null);
      const tag = tagged(warned, READ_ERROR_TAG);
      assert.ok(tag, "a failed rep lookup must be visible in the logs");
      assert.equal(tag[1].tenantId, TENANT);
    } finally {
      await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
  });

  if (failures) {
    console.error(`kixie-deactivated-rep-automations: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("kixie-deactivated-rep-automations: ok");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
