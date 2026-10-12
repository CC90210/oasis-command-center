/**
 * offer-funnel-events.test.ts - V5a funnel tracking (HANDOVER section 5):
 * migration bravo__218_offer_funnel_events.sql, the public ingest route
 * (/api/offer-events), the /go/community save-basin redirect, and the
 * submit route's visit->lead link + first-touch UTM stamp.
 *
 * Covers (against a real local libSQL file, through the real routes):
 *   1. An event for an unknown or disabled form is dropped with 204, and
 *      writes nothing.
 *   2. A body field that LOOKS like a tenant/form id is ignored -- only the
 *      server-resolved tenant_id/form_id ever lands in a row.
 *   3. No IP, User-Agent or cookie is ever stored (structural: the table's
 *      own columns, and the stored row content).
 *   4. A visit is linked to a lead ONLY at submit, and only the visit that
 *      actually submitted -- a sibling visit_id that never submits stays
 *      unlinked forever.
 *   5. UTM fields land on the lead's `data`, and lead_source (a different,
 *      pre-existing axis) is untouched by them.
 *   6. /go/community never redirects anywhere a query string asks it to; it
 *      always answers with the one server-configured OASIS community URL
 *      for an OASIS tenant, and 404s for every other tenant (none configured
 *      yet). It also records community_click and, when the visit already
 *      resolved to a lead, the save_basin.enrolled interaction.
 *   7. Funnel counts (views/video_plays/community) are tenant-isolated: two
 *      tenants sharing a form slug never see each other's numbers.
 *   8. (Codex review, PR #598, 2026-10-12 [P2]) An event inserted WELL AFTER
 *      submit -- not one of the rows present at submit time -- still gets
 *      lead_id stamped immediately, via the persistent
 *      offer_funnel_visit_leads mapping, never a client-supplied value.
 *   9. (Codex review, PR #598 [P2]) stampUtmOnLead's atomic UPDATE never
 *      discards an unrelated field on the lead, and two overlapping calls
 *      for the same lead do not corrupt it -- the stored value is exactly
 *      one of the two, never a mixed/partial write.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-funnel-events.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLIENT_A, CLIENT_B, OASIS, check, finish, setupDatabase, splitSql } from "./_delivery-harness";

process.env.FORM_LINK_HMAC_KEY = "offer-funnel-events-signing-key-0123456789";

// next/server's after() needs a request scope this harness doesn't open;
// nothing this suite exercises relies on its background work.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the real module is spread into the stand-in
const realServer = require("next/server") as Record<string, unknown>;
const serverPath = require.resolve("next/server");
require.cache[serverPath] = {
  id: serverPath,
  filename: serverPath,
  path: dirname(serverPath),
  loaded: true,
  children: [],
  paths: [],
  exports: { ...realServer, after: () => undefined },
} as unknown as NodeModule;

const ROOT = join(__dirname, "..");
const MIGRATION_PATH = join(ROOT, "database", "turso", "bravo__218_offer_funnel_events.sql");

/** OASIS's own tenant id (lib/ai/tools/client-safe-registry.ts
 *  OASIS_INTERNAL_TENANT_IDS) -- the same id, and the same "oasis-ai-cc" tenant
 *  row, _delivery-harness.ts already seeds as OASIS. */
const OASIS_TENANT = OASIS;

const FORM_A = "f1000000-0000-4000-8000-00000000000a"; // CLIENT_A / "intake"
const FORM_B = "f2000000-0000-4000-8000-00000000000b"; // CLIENT_B / "intake" (same slug, different tenant)
const FORM_DISABLED = "f3000000-0000-4000-8000-00000000000c"; // CLIENT_A / "off"
const FORM_OASIS = "f4000000-0000-4000-8000-00000000000d"; // OASIS / "lounge"
const FORM_TWO_STEP = "f5000000-0000-4000-8000-00000000000e"; // CLIENT_A / "two-step"

const STEPS = [
  {
    key: "contact",
    title: "Your details",
    fields: [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone", type: "phone", required: true },
    ],
  },
];

/** Two steps, so a TOKEN-authenticated step 1 can be rejected without ever
 *  touching step 0's lead-creation path -- the ordering test (Codex P2) needs
 *  exactly this shape. */
const STEPS_TWO = [
  STEPS[0],
  {
    key: "more",
    title: "One more thing",
    fields: [{ name: "company", label: "Company", type: "text", required: true }],
  },
];

type Json = Record<string, unknown>;

function randomVisitId(): string {
  // Matches the 16-128 char [A-Za-z0-9_-] shape isValidVisitId requires --
  // a real crypto.randomUUID() is a subset of this, but the test does not
  // need the Web Crypto API to construct one.
  return `visit-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

async function main() {
  const db = await setupDatabase();
  // Same FK-embedding fix forms-submit-validate-first.test.ts uses: the
  // submit route's form read embeds tenants!inner(slug).
  await db.executeMultiple(`
    ALTER TABLE forms RENAME TO forms_without_fk;
    CREATE TABLE forms (
      id TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (id));
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT,
      publisher_agent TEXT, target_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  `);
  for (const stmt of splitSql(readFileSync(MIGRATION_PATH, "utf8"))) await db.execute(stmt);

  await db.batch(
    [
      { sql: `INSERT INTO forms (id, tenant_id, slug, name, steps, enabled) VALUES (?, ?, 'intake', 'Intake', ?, 1)`, args: [FORM_A, CLIENT_A, JSON.stringify(STEPS)] },
      { sql: `INSERT INTO forms (id, tenant_id, slug, name, steps, enabled) VALUES (?, ?, 'intake', 'Intake', ?, 1)`, args: [FORM_B, CLIENT_B, JSON.stringify(STEPS)] },
      { sql: `INSERT INTO forms (id, tenant_id, slug, name, steps, enabled) VALUES (?, ?, 'off', 'Off', ?, 0)`, args: [FORM_DISABLED, CLIENT_A, JSON.stringify(STEPS)] },
      { sql: `INSERT INTO forms (id, tenant_id, slug, name, steps, enabled) VALUES (?, ?, 'lounge', 'Lounge', ?, 1)`, args: [FORM_OASIS, OASIS_TENANT, JSON.stringify(STEPS)] },
      { sql: `INSERT INTO forms (id, tenant_id, slug, name, steps, enabled) VALUES (?, ?, 'two-step', 'Two Step', ?, 1)`, args: [FORM_TWO_STEP, CLIENT_A, JSON.stringify(STEPS_TWO)] },
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const eventsRoute = await import("../app/api/offer-events/route");
  const communityRoute = await import("../app/go/community/route");
  const submitRoute = await import("../app/api/forms/submit/route");

  const postEvent = async (body: Json) =>
    eventsRoute.POST(
      new NextRequest("http://localhost/api/offer-events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.9",
          "user-agent": "Mozilla/5.0 (test-agent-marker)",
          cookie: "session=should-never-be-stored",
        },
        body: JSON.stringify(body),
      }),
    );

  const getCommunity = async (qs: string) =>
    communityRoute.GET(new NextRequest(`http://localhost/go/community${qs}`));

  const eventsFor = async (tenantId: string, formId: string) =>
    (
      await db.execute({
        sql: "SELECT * FROM offer_funnel_events WHERE tenant_id = ? AND form_id = ? ORDER BY created_at",
        args: [tenantId, formId],
      })
    ).rows as unknown as Json[];

  const allEventsCount = async () => (await db.execute("SELECT COUNT(*) AS n FROM offer_funnel_events")).rows[0].n as number;

  let ip = 0;
  const submit = async (body: Json) => {
    ip += 1;
    const res = await submitRoute.POST(
      new NextRequest("http://localhost/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${ip}` },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    let parsed: Json = {};
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      /* status says enough */
    }
    return { status: res.status, body: parsed, text };
  };
  const lead = async (id: string) => {
    const row = (await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] })).rows[0];
    return row ? (JSON.parse(String(row.data)) as Json) : null;
  };

  console.log("offer-funnel-events:");

  // -- 1. structural: no PII column exists at all --------------------------
  await check("the table has no IP/User-Agent/cookie column", async () => {
    const info = (await db.execute("PRAGMA table_info(offer_funnel_events)")).rows as unknown as Array<{ name: string }>;
    const cols = info.map((r) => String(r.name)).sort();
    assert.deepEqual(cols, ["created_at", "detail", "event", "form_id", "id", "lead_id", "step_index", "tenant_id", "visit_id"].sort());
  });

  // -- 2. unknown / disabled form: 204, nothing written ---------------------
  await check("an event for an unknown form is dropped with 204 and writes nothing", async () => {
    const before = await allEventsCount();
    const res = await postEvent({ tenant: "client-a", form: "no-such-form", visit_id: randomVisitId(), event: "page_view" });
    assert.equal(res.status, 204);
    assert.equal(await allEventsCount(), before, "a row was written for an unknown form");
  });
  await check("an event for a disabled form is dropped with 204 and writes nothing", async () => {
    const before = await allEventsCount();
    const res = await postEvent({ tenant: "client-a", form: "off", visit_id: randomVisitId(), event: "page_view" });
    assert.equal(res.status, 204);
    assert.equal(await allEventsCount(), before, "a row was written for a disabled form");
  });
  await check("a malformed event name is dropped with 204 and writes nothing", async () => {
    const before = await allEventsCount();
    const res = await postEvent({ tenant: "client-a", form: "intake", visit_id: randomVisitId(), event: "not_a_real_event" });
    assert.equal(res.status, 204);
    assert.equal(await allEventsCount(), before);
  });

  // -- 3. a body field that looks like an id is ignored ---------------------
  await check("a body tenant_id is ignored -- only the server-resolved id ever lands in the row", async () => {
    const visitId = randomVisitId();
    const res = await postEvent({
      tenant: "client-a",
      form: "intake",
      visit_id: visitId,
      event: "page_view",
      // Neither field exists in the route's Body type; this proves they are
      // never read even if present.
      tenant_id: "11111111-1111-4111-8111-111111111111",
      form_id: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(res.status, 204);
    const rows = await eventsFor(CLIENT_A, FORM_A);
    const row = rows.find((r) => r.visit_id === visitId);
    assert.ok(row, "the event landed under the real, server-resolved tenant/form id");
    assert.equal(row!.tenant_id, CLIENT_A);
    assert.equal(row!.form_id, FORM_A);
  });

  // -- 4. no PII in the stored row content -----------------------------------
  await check("no IP, User-Agent or cookie value reaches the stored row", async () => {
    const visitId = randomVisitId();
    await postEvent({ tenant: "client-a", form: "intake", visit_id: visitId, event: "page_view" });
    const rows = await eventsFor(CLIENT_A, FORM_A);
    const row = rows.find((r) => r.visit_id === visitId)!;
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes("203.0.113"), "an IP address leaked into the row");
    assert.ok(!serialized.includes("Mozilla"), "a User-Agent leaked into the row");
    assert.ok(!serialized.includes("should-never-be-stored"), "a cookie value leaked into the row");
  });

  // -- 5. whitelisted detail only --------------------------------------------
  await check("video_progress detail is limited to a real checkpoint; everything else is dropped", async () => {
    const good = randomVisitId();
    await postEvent({ tenant: "client-a", form: "intake", visit_id: good, event: "video_progress", detail: { percent: 50 } });
    const goodRow = (await eventsFor(CLIENT_A, FORM_A)).find((r) => r.visit_id === good)!;
    assert.deepEqual(JSON.parse(String(goodRow.detail)), { percent: 50 });

    const bad = randomVisitId();
    await postEvent({ tenant: "client-a", form: "intake", visit_id: bad, event: "video_progress", detail: { percent: 37, injected: "<script>" } });
    const badRow = (await eventsFor(CLIENT_A, FORM_A)).find((r) => r.visit_id === bad)!;
    assert.equal(badRow.detail, null, "an out-of-range percent (and any extra key) must not be stored");
  });

  // -- 6. visit->lead link happens ONLY at submit ----------------------------
  await check("a visit is linked to its lead only at submit; a sibling visit that never submits stays unlinked", async () => {
    const submittingVisit = randomVisitId();
    const siblingVisit = randomVisitId();
    await postEvent({ tenant: "client-a", form: "intake", visit_id: submittingVisit, event: "page_view" });
    await postEvent({ tenant: "client-a", form: "intake", visit_id: siblingVisit, event: "page_view" });

    const beforeSubmitting = (await eventsFor(CLIENT_A, FORM_A)).find((r) => r.visit_id === submittingVisit)!;
    assert.equal(beforeSubmitting.lead_id, null, "precondition: unlinked before submit");

    const res = await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Vera Visitor", email: `vera-${submittingVisit}@visitor.test`, phone: "+15550004444" },
      visit_id: submittingVisit,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));

    const leadsRow = (
      await db.execute({
        sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${submittingVisit}%`],
      })
    ).rows[0];
    assert.ok(leadsRow, "precondition: the submit created a lead whose email carries the visit marker");
    const leadId = String(leadsRow.id);

    const afterSubmitting = (await eventsFor(CLIENT_A, FORM_A)).find((r) => r.visit_id === submittingVisit)!;
    assert.equal(afterSubmitting.lead_id, leadId, "the submitting visit's event must now carry the real lead id");

    const siblingAfter = (await eventsFor(CLIENT_A, FORM_A)).find((r) => r.visit_id === siblingVisit)!;
    assert.equal(siblingAfter.lead_id, null, "a visit that never submitted must stay unlinked forever");
  });

  // -- 7. UTMs land on the lead; lead_source is a separate, untouched axis ---
  await check("UTM fields are stamped on the lead's data; lead_source stays whatever origination gave it", async () => {
    const visitId = randomVisitId();
    const email = `utm-${visitId}@visitor.test`;
    const res = await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Uma UTM", email, phone: "+15550005555" },
      visit_id: visitId,
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "fall-launch",
      kw: "ai automation",
      cat: "p2",
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const row = (
      await db.execute({
        sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    assert.ok(row, "the lead must exist");
    const data = JSON.parse(String(row.data)) as Json;
    assert.equal(data.utm_source, "google");
    assert.equal(data.utm_medium, "cpc");
    assert.equal(data.utm_campaign, "fall-launch");
    assert.equal(data.kw, "ai automation");
    assert.equal(data.cat, "p2");
    // lead_source is the Text/Dial/Email origination axis (lib/forms/lead-source.ts),
    // stamped independently at lead creation -- "unknown" here because no
    // ?source= was sent, and the UTM stamp must never have touched it.
    assert.equal(data.lead_source, "unknown", "UTM stamping must not write or alter lead_source");
  });

  await check("a lead's first UTM touch wins -- a later submit with different UTMs changes nothing", async () => {
    const visitId = randomVisitId();
    const email = `firsttouch-${visitId}@visitor.test`;
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "First Touch", email, phone: "+15550006666" },
      visit_id: visitId,
      utm_source: "first-source",
      cat: "p1",
    });
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "First Touch Returning", email, phone: "+15550006666" },
      visit_id: randomVisitId(),
      utm_source: "second-source",
      cat: "p4",
    });
    const row = (
      await db.execute({
        sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    const data = JSON.parse(String(row.data)) as Json;
    assert.equal(data.utm_source, "first-source", "first touch must win");
    assert.equal(data.cat, "p1", "first touch must win");
  });

  // -- 8. /go/community: never an open redirect, OASIS-only ------------------
  await check("/go/community ignores any destination the query string supplies, and 404s for a tenant with no community", async () => {
    const res = await getCommunity("?form=intake&t=client-a&v=" + randomVisitId() + "&dest=https://evil.example&url=https://evil.example");
    assert.equal(res.status, 404, "a non-OASIS tenant has no community configured yet");
    assert.equal(res.headers.get("location"), null, "no redirect at all, and certainly not to the injected dest/url");
  });
  await check("/go/community redirects an OASIS tenant to the fixed server-configured URL, never a query-supplied one", async () => {
    const visitId = randomVisitId();
    const res = await getCommunity(`?form=lounge&t=oasis-ai-cc&v=${visitId}&dest=https://evil.example&url=https://evil.example&redirect=https://evil.example`);
    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert.equal(location, "https://t.me/+w_8rgh8YBWg4YmM5", "must be exactly the fixed OASIS community URL");
    assert.ok(!String(location).includes("evil.example"), "must never reflect a query-supplied destination");
    const rows = await eventsFor(OASIS_TENANT, FORM_OASIS);
    const row = rows.find((r) => r.visit_id === visitId);
    assert.ok(row, "the community_click event must be recorded");
    assert.equal(row!.event, "community_click");
  });
  await check("/go/community writes the save_basin.enrolled interaction when the visit already resolved to a lead", async () => {
    const visitId = randomVisitId();
    const email = `savebasin-${visitId}@visitor.test`;
    // The visit must have a row BEFORE submit (exactly as a real page_view
    // beacon would have written one) for linkVisitToLead to have anything to
    // link -- submit never creates the tracking row itself, only stamps
    // lead_id onto whatever this visit already wrote.
    await postEvent({ tenant: "oasis-ai-cc", form: "lounge", visit_id: visitId, event: "page_view" });
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: "lounge" },
      payload: { name: "Save Basin", email, phone: "+15550007777" },
      visit_id: visitId,
    });
    const leadRow = (
      await db.execute({
        sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [OASIS_TENANT, `%${email}%`],
      })
    ).rows[0];
    assert.ok(leadRow, "precondition: the lead exists");
    const leadId = String(leadRow.id);

    await getCommunity(`?form=lounge&t=oasis-ai-cc&v=${visitId}`);

    const interactions = (
      await db.execute({ sql: "SELECT type, lead_id FROM lead_interactions WHERE lead_id = ?", args: [leadId] })
    ).rows as unknown as Array<{ type: string; lead_id: string }>;
    assert.ok(interactions.some((r) => r.type === "save_basin.enrolled"), "save_basin.enrolled must be recorded for a visit that already has a lead");
  });
  await check("/go/community without a resolvable visit still redirects, recording nothing", async () => {
    const before = await allEventsCount();
    const res = await getCommunity("?form=lounge&t=oasis-ai-cc");
    assert.equal(res.status, 302);
    assert.equal(await allEventsCount(), before, "no visit id means nothing to record -- but the redirect must still happen");
  });

  // -- 9. funnel counts are tenant-isolated ----------------------------------
  await check("counts per form are tenant-isolated: two tenants sharing the 'intake' slug never see each other's numbers", async () => {
    const { countFunnelEventMetrics } = await import("../lib/offers/tracking-store");
    const dbClient = (await import("../lib/offer-pages/store")).offerPagesDb()!;
    for (let i = 0; i < 3; i++) {
      await postEvent({ tenant: "client-a", form: "intake", visit_id: randomVisitId(), event: "page_view" });
    }
    await postEvent({ tenant: "client-b", form: "intake", visit_id: randomVisitId(), event: "page_view" });

    const since = "2000-01-01T00:00:00.000Z";
    const countsA = await countFunnelEventMetrics(dbClient, CLIENT_A, [FORM_A], since);
    const countsB = await countFunnelEventMetrics(dbClient, CLIENT_B, [FORM_B], since);
    assert.ok((countsA[FORM_A].views ?? 0) >= 3, "tenant A must see at least its own 3 views");
    assert.ok((countsB[FORM_B].views ?? 0) >= 1, "tenant B must see its own view");
    // The cross-tenant isolation check that matters: asking for CLIENT_B's
    // tenant_id against CLIENT_A's own form_id must find nothing (the WHERE
    // clause leads with tenant_id, not just form_id).
    const crossed = await countFunnelEventMetrics(dbClient, CLIENT_B, [FORM_A], since);
    assert.equal(crossed[FORM_A].views, 0, "CLIENT_B asking about CLIENT_A's own form_id must see zero, never CLIENT_A's rows");
  });

  // -- 10. 13-month retention purge ------------------------------------------
  await check("purgeFunnelEventsOlderThan deletes exactly the rows past the cutoff, and nothing else", async () => {
    const { purgeFunnelEventsOlderThan, retentionCutoff } = await import("../lib/offers/tracking-store");
    const dbClient = (await import("../lib/offer-pages/store")).offerPagesDb()!;
    const oldVisit = randomVisitId();
    const freshVisit = randomVisitId();
    await db.batch(
      [
        {
          sql: "INSERT INTO offer_funnel_events (id, tenant_id, form_id, visit_id, event, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'page_view', '2024-01-01T00:00:00.000Z')",
          args: [CLIENT_A, FORM_A, oldVisit],
        },
        {
          sql: "INSERT INTO offer_funnel_events (id, tenant_id, form_id, visit_id, event, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'page_view', ?)",
          args: [CLIENT_A, FORM_A, freshVisit, new Date().toISOString()],
        },
      ],
      "write",
    );
    const cutoff = retentionCutoff(new Date());
    assert.ok(cutoff < new Date().toISOString(), "the cutoff must be in the past relative to now");
    const deleted = await purgeFunnelEventsOlderThan(dbClient, cutoff);
    assert.ok(deleted >= 1, "at least the 2024 row must be purged");
    const remainingOld = (await db.execute({ sql: "SELECT 1 FROM offer_funnel_events WHERE visit_id = ?", args: [oldVisit] })).rows.length;
    assert.equal(remainingOld, 0, "the row older than 13 months must be gone");
    const remainingFresh = (await db.execute({ sql: "SELECT 1 FROM offer_funnel_events WHERE visit_id = ?", args: [freshVisit] })).rows.length;
    assert.equal(remainingFresh, 1, "a fresh row must survive the purge");
  });

  // -- 11. an event long after submit still links, via the persistent mapping --
  await check("an event inserted well after submit (not present at submit time) still gets lead_id stamped, via the persistent mapping", async () => {
    const { insertFunnelEvent } = await import("../lib/offers/tracking-store");
    const dbClient = (await import("../lib/offer-pages/store")).offerPagesDb()!;
    const visitId = randomVisitId();
    const email = `late-event-${visitId}@visitor.test`;
    // No postEvent before submit this time -- the visit has NO row at all
    // when submit runs, so linkVisitToLead's backfill UPDATE has nothing to
    // touch. Only the persistent mapping it also writes can save this.
    const res = await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Late Event", email, phone: "+15550008888" },
      visit_id: visitId,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const leadRow = (
      await db.execute({
        sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    assert.ok(leadRow, "precondition: the lead exists");
    const leadId = String(leadRow.id);

    // A step_submitted beacon (or any later event) arriving well after the
    // response -- inserted directly, exactly as the ingest route would.
    const wrote = await insertFunnelEvent(dbClient, {
      tenantId: CLIENT_A,
      formId: FORM_A,
      visitId,
      event: "step_submitted",
      stepIndex: 0,
    });
    assert.equal(wrote, true);
    const lateRow = (await eventsFor(CLIENT_A, FORM_A)).find((r) => r.visit_id === visitId && r.event === "step_submitted")!;
    assert.ok(lateRow, "the late event must be recorded");
    assert.equal(lateRow.lead_id, leadId, "a late event must be linked immediately from the persistent mapping, never anonymous");
  });

  await check("the ingest route itself (not just insertFunnelEvent directly) stamps lead_id on a late event through the persistent mapping", async () => {
    const visitId = randomVisitId();
    const email = `late-ingest-${visitId}@visitor.test`;
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Late Ingest", email, phone: "+15550009999" },
      visit_id: visitId,
    });
    const leadRow = (
      await db.execute({
        sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    const leadId = String(leadRow.id);

    await postEvent({ tenant: "client-a", form: "intake", visit_id: visitId, event: "video_play" });
    const row = (await eventsFor(CLIENT_A, FORM_A)).find((r) => r.visit_id === visitId && r.event === "video_play")!;
    assert.equal(row.lead_id, leadId, "the public ingest route must stamp lead_id on a late event too, via the same persistent mapping");
  });

  // -- 12. stampUtmOnLead's atomic update: no corruption, no discarded fields --
  await check("stampUtmOnLead's atomic update never discards an unrelated field already on the lead", async () => {
    const { stampUtmOnLead } = await import("../lib/offer-pages/utm");
    const dbClient = (await import("../lib/offer-pages/store")).offerPagesDb()!;
    const visitId = randomVisitId();
    const email = `unrelated-${visitId}@visitor.test`;
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Unrelated Field", email, phone: "+15551110000" },
      visit_id: visitId,
    });
    const leadRow = (
      await db.execute({
        sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    const leadId = String(leadRow.id);
    // A field this helper has nothing to do with, committed by some OTHER
    // write between a hypothetical read and write -- the old read-modify-
    // write implementation would have clobbered this; the atomic UPDATE
    // (json_set on named paths only) must leave it exactly alone.
    await db.execute({
      sql: "UPDATE tenant_records SET data = json_set(data, '$.custom_note', 'keep me') WHERE id = ?",
      args: [leadId],
    });
    await stampUtmOnLead(dbClient, { tenantId: CLIENT_A, leadId, utm: { utm_source: "google" }, now: new Date().toISOString() });
    const after = (await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [leadId] })).rows[0];
    const data = JSON.parse(String(after.data)) as Json;
    assert.equal(data.custom_note, "keep me", "an unrelated field committed between read and write must survive the atomic stamp");
    assert.equal(data.utm_source, "google");
  });

  await check("stampUtmOnLead sends exactly ONE statement (an UPDATE with a json_set/COALESCE expression), never a SELECT-then-write pair", async () => {
    const { stampUtmOnLead } = await import("../lib/offer-pages/utm");
    const realDb = (await import("../lib/offer-pages/store")).offerPagesDb()!;
    const visitId = randomVisitId();
    const email = `spy-${visitId}@visitor.test`;
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Spy Target", email, phone: "+15553330000" },
      visit_id: visitId,
    });
    const leadRow = (
      await db.execute({
        sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    const leadId = String(leadRow.id);

    // A thin spy over the real client's .execute -- counts calls and
    // captures the SQL text, without faking the database itself. A read-
    // then-write implementation sends a SELECT and then a separate UPDATE
    // (2 calls); the atomic version sends exactly one UPDATE whose SET
    // expression is json_set(...) guarded by COALESCE(json_extract(...)).
    const calls: Array<{ sql: string }> = [];
    const realExecute = realDb.execute.bind(realDb);
    const spiedDb = Object.create(realDb) as typeof realDb;
    spiedDb.execute = ((stmt: unknown) => {
      const sql = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
      calls.push({ sql });
      return realExecute(stmt as never);
    }) as typeof realDb.execute;

    await stampUtmOnLead(spiedDb, { tenantId: CLIENT_A, leadId, utm: { utm_source: "spy-source" }, now: new Date().toISOString() });

    assert.equal(calls.length, 1, `exactly one statement must be sent for one stampUtmOnLead call -- a read-then-write sends two (SELECT + UPDATE). Saw: ${JSON.stringify(calls)}`);
    assert.match(calls[0].sql, /^UPDATE tenant_records SET data = json_set\(data,/, "must be a single UPDATE whose value is a json_set(...) expression");
    assert.match(calls[0].sql, /COALESCE\(NULLIF\(TRIM\(json_extract\(data, '\$\.utm_source'\)\), ''\), \?\)/, "each stamped key must be guarded by COALESCE(NULLIF(TRIM(json_extract(...)), ''), ?) so the database -- not a prior JS read -- decides first-touch, and a stored blank counts as unset");
    assert.doesNotMatch(calls[0].sql, /^SELECT/i, "must never be a plain SELECT (that would mean a read-then-write shape)");
  });

  await check("a stored blank or whitespace-only utm field does not block the first real value", async () => {
    const { stampUtmOnLead } = await import("../lib/offer-pages/utm");
    const visitId = randomVisitId();
    const email = `blank-${visitId}@visitor.test`;
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Blank Target", email, phone: "+15553330001" },
      visit_id: visitId,
    });
    const leadId = String(
      (
        await db.execute({
          sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
          args: [CLIENT_A, `%${email}%`],
        })
      ).rows[0].id,
    );
    await db.execute({
      sql: "UPDATE tenant_records SET data = json_set(data, '$.utm_source', '', '$.utm_medium', '   ') WHERE id = ?",
      args: [leadId],
    });
    const realDb = (await import("../lib/offer-pages/store")).offerPagesDb()!;
    await stampUtmOnLead(realDb, { tenantId: CLIENT_A, leadId, utm: { utm_source: "google", utm_medium: "cpc" }, now: new Date().toISOString() });
    const data = JSON.parse(String((await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [leadId] })).rows[0].data)) as Json;
    assert.equal(data.utm_source, "google", "an empty stored value must accept the first real value");
    assert.equal(data.utm_medium, "cpc", "a whitespace-only stored value must accept the first real value");
  });

  await check("two overlapping stampUtmOnLead calls for the same lead do not corrupt it: the stored value is exactly one of the two", async () => {
    const { stampUtmOnLead } = await import("../lib/offer-pages/utm");
    const dbClient = (await import("../lib/offer-pages/store")).offerPagesDb()!;
    const visitId = randomVisitId();
    const email = `concurrent-utm-${visitId}@visitor.test`;
    await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "intake" },
      payload: { name: "Concurrent UTM", email, phone: "+15552220000" },
      visit_id: visitId,
    });
    const leadRow = (
      await db.execute({
        sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    const leadId = String(leadRow.id);

    await Promise.all([
      stampUtmOnLead(dbClient, { tenantId: CLIENT_A, leadId, utm: { utm_source: "race-a" }, now: new Date().toISOString() }),
      stampUtmOnLead(dbClient, { tenantId: CLIENT_A, leadId, utm: { utm_source: "race-b" }, now: new Date().toISOString() }),
    ]);
    const after = (await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [leadId] })).rows[0];
    const data = JSON.parse(String(after.data)) as Json;
    assert.ok(["race-a", "race-b"].includes(String(data.utm_source)), `utm_source must be exactly one clean value, got ${JSON.stringify(data.utm_source)}`);
  });

  // -- 13. attribution stamps only AFTER validation passes (Codex P2) --------
  await check("a rejected TOKEN-authenticated step never stamps UTM attribution; a later valid one still can", async () => {
    const visitId = randomVisitId();
    const email = `order-${visitId}@visitor.test`;
    const step0 = await submit({
      step_index: 0,
      anonymous_init: { tenant_slug: "client-a", form_slug: "two-step" },
      payload: { name: "Order Test", email, phone: "+15554440000" },
      visit_id: visitId,
    });
    assert.equal(step0.status, 200, step0.text.slice(0, 300));
    const token = step0.body.minted_token as string | undefined;
    assert.ok(token, "step 0 must mint a token for step 1 to use");

    const leadRow = (
      await db.execute({
        sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND data LIKE ?",
        args: [CLIENT_A, `%${email}%`],
      })
    ).rows[0];
    const leadId = String(leadRow.id);

    // Step 1, TOKEN-authenticated (not anonymous_init -- this is the exact
    // path Codex's note names), missing its required field. Must be
    // rejected, and must NOT stamp utm_source even though the body carries
    // one.
    const rejected = await submit({ token, step_index: 1, payload: {}, utm_source: "should-never-land" });
    assert.equal(rejected.status, 400, rejected.text.slice(0, 300));
    const afterReject = await lead(leadId);
    assert.equal(afterReject?.utm_source, undefined, "a rejected submission must never stamp attribution, even when the body carries one");

    // The same step, completed VALIDLY, with the CORRECT attribution this
    // time -- proving the bug's actual harm (a permanently wrong first-touch
    // value locking out the correct one) cannot happen: nothing was stamped
    // by the rejection, so this is still a true first touch.
    const accepted = await submit({ token, step_index: 1, payload: { company: "Order Co" }, utm_source: "correct-source" });
    assert.equal(accepted.status, 200, accepted.text.slice(0, 300));
    const afterAccept = await lead(leadId);
    assert.equal(afterAccept?.utm_source, "correct-source", "the later VALID submission must still be able to supply the correct attribution");
  });

  finish("offer-funnel-events");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
