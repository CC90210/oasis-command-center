/**
 * offer-pages-notify.test.ts - a new lead on an offer page alerts its own
 * workspace, once (lib/offer-pages/notify.ts and the submit route), design
 * sections F6/S4 and 6.5.
 *
 * WHAT IS PINNED:
 *   1. A new lead on a generic OASIS offer sends exactly ONE alert to OASIS's
 *      operator chat, even when two step-0 submits race; a returning lead's
 *      later step-0 sends nothing.
 *   2. A client workspace's offer never reaches OASIS's Telegram: with no bot
 *      connected nothing is sent (and no failure marker, that was its choice);
 *      with its own bot connected, the alert reaches that bot and chat only.
 *   3. Through the real submit route: a generic OASIS offer alerts on the first
 *      step; OASIS's `ai-audit` (which has its own step-0 alert) is not alerted
 *      twice; a form with no offer page sends no offer alert.
 *   4. The shared first-submission helper (lib/forms/first-submission.ts) gives
 *      the same answer to both callers: the AI-audit step-0 alert and the offer
 *      alert agree on which of two racing submissions is the new lead's.
 *   5. A delivery that fails leaves a marker on the lead's timeline.
 *
 * Stand-ins: fetch (records every Telegram call, answers 200 or 500 per chat)
 * and next/server's after() (collects the background work so the test runs it).
 * Every OASIS Telegram credential is set to a value a leak would show.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-notify.test.ts
 */
import { CLIENT_A, CLIENT_B, OASIS, done, applyOfferMigration, createLibraryTables, offerRow, step, minimalDoc, stubPath } from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { setupDatabase } from "./_delivery-harness";

process.env.FORM_LINK_HMAC_KEY = "offer-pages-notify-signing-key-0123456789abcdef";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "offer-pages-notify-field-key-material";
process.env.OASIS_TELEGRAM_BOT_TOKEN = "1001:oasis-operator-token";
process.env.OASIS_TELEGRAM_CHAT_ID = "5550001";
process.env.SUNBIZ_OPS_TELEGRAM_BOT_TOKEN = "1003:sunbiz-ops-token";
process.env.SUNBIZ_OPS_TELEGRAM_CHAT_ID = "-1005550003";

type Call = { token: string; chatId: string; text: string };
const calls: Call[] = [];
const failingChats = new Set<string>();
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const m = /api\.telegram\.org\/bot([^/]+)\/sendMessage/.exec(url);
  if (m) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string; text?: string };
    calls.push({ token: m[1], chatId: String(body.chat_id), text: String(body.text) });
    if (failingChats.has(String(body.chat_id))) return new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the real module is spread into the stand-in
const realServer = require("next/server") as Record<string, unknown>;
const afterQueue: Array<() => unknown> = [];
stubPath(require.resolve("next/server"), { ...realServer, after: (fn: () => unknown) => void afterQueue.push(fn) });
async function drainAfter() {
  while (afterQueue.length) {
    const fn = afterQueue.shift()!;
    try {
      await fn();
    } catch {
      // background work that is not what this test pins
    }
  }
}

const OFFER_OASIS = "f0ce0000-0000-4000-8000-000000000001";
const OFFER_A = "f0ce0000-0000-4000-8000-00000000000a";
const OFFER_B = "f0ce0000-0000-4000-8000-00000000000b";
const AUDIT = "f0ce0000-0000-4000-8000-0000000000ad";
const PLAIN = "f0ce0000-0000-4000-8000-0000000000ff";
const STEPS = [
  {
    key: "contact",
    title: "Your details",
    fields: [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Mobile", type: "phone", required: true },
      { name: "company", label: "Company", type: "text" },
    ],
  },
  { key: "more", title: "More", fields: [{ name: "details", label: "Details", type: "textarea" }] },
];

async function main() {
  const db = await setupDatabase();
  // The submit route's form read embeds tenants!inner(slug), which the adapter
  // resolves through a real foreign key (as tests/forms-submit-validate-first.test.ts).
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
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, profile_id TEXT, service TEXT NOT NULL, field_key TEXT NOT NULL, encrypted_value TEXT,
      created_at TEXT, updated_at TEXT);
  `);
  await applyOfferMigration(db);
  await createLibraryTables(db);
  const { AI_AUDIT_STEPS } = await import("../lib/forms/oasis-ai-audit-seed");
  const form = (id: string, tenant: string, slug: string, name: string, steps: unknown) => ({
    sql: `INSERT INTO forms (id, tenant_id, slug, name, steps, on_complete_stage, enabled) VALUES (?, ?, ?, ?, ?, 'researched', 1)`,
    args: [id, tenant, slug, name, JSON.stringify(steps)],
  });
  const { encryptField } = await import("../lib/field-encryption");
  await db.batch(
    [
      form(OFFER_OASIS, OASIS, "growth-offer", "Growth Offer", STEPS),
      form(OFFER_A, CLIENT_A, "spring-offer", "Spring Offer", STEPS),
      form(OFFER_B, CLIENT_B, "smile-offer", "Smile Offer", STEPS),
      form(AUDIT, OASIS, "ai-audit", "AI Automation Audit", AI_AUDIT_STEPS),
      form(PLAIN, OASIS, "plain", "Plain intake", STEPS),
      offerRow({ formId: OFFER_OASIS, tenantId: OASIS, draft: minimalDoc() }),
      offerRow({ formId: OFFER_A, tenantId: CLIENT_A, draft: minimalDoc() }),
      offerRow({ formId: OFFER_B, tenantId: CLIENT_B, draft: minimalDoc() }),
      offerRow({ formId: AUDIT, tenantId: OASIS, draft: minimalDoc({ template: "free_audit" }), template: "free_audit" }),
      // Client B connected its own bot under Connections > Telegram.
      { sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'telegram', 'bot_token', ?)", args: [CLIENT_B, encryptField("2002:client-b-own-bot")] },
      { sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'telegram', 'chat_id', ?)", args: [CLIENT_B, encryptField("-1009990002")] },
    ],
    "write",
  );

  const { notifyOfferLead } = await import("../lib/offer-pages/notify");
  const { notifyAiAuditStarted } = await import("../lib/forms/ai-audit-notify");
  const { isFirstSubmissionForLead } = await import("../lib/forms/first-submission");
  const { offerPagesDb } = await import("../lib/offer-pages/store");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const supa = getServiceSupabase();
  const offers = offerPagesDb();
  assert.ok(offers, "precondition: the offer-pages database is the harness file");

  let seq = 0;
  const lead = async (tenant: string, name: string) => {
    const id = `1ead0000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    await db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)", args: [id, tenant, JSON.stringify({ name })] });
    return id;
  };
  const submission = async (id: string, formId: string, tenant: string, leadId: string, at: string) => {
    await db.execute({
      sql: "INSERT INTO form_submissions (id, form_id, tenant_id, lead_id, step_index, payload, submitted_at) VALUES (?, ?, ?, ?, 0, '{}', ?)",
      args: [id, formId, tenant, leadId, at],
    });
    return id;
  };
  const answers = { name: "Dana Lead", email: "dana@lead.test", phone: "+15145550100", company: "Dana & Co <script>" };
  const reset = () => {
    calls.length = 0;
    failingChats.clear();
  };
  const toOasis = () => calls.filter((c) => c.token.startsWith("1001:") || c.chatId === "5550001");

  console.log("offer-pages-notify:");

  await step("a new lead on a generic OASIS offer: exactly one alert to the operator chat, even with two racing step-0 submits", async () => {
    reset();
    const L = await lead(OASIS, "Dana");
    // Same timestamp: id decides, so exactly one of them is "the oldest".
    const s1 = await submission("s-race-a", OFFER_OASIS, OASIS, L, "2026-10-08T12:00:00.000Z");
    const s2 = await submission("s-race-b", OFFER_OASIS, OASIS, L, "2026-10-08T12:00:00.000Z");
    const results = await Promise.all(
      [s2, s1].map((sid) => notifyOfferLead({ db: supa, offers, tenantId: OASIS, formId: OFFER_OASIS, formName: "Growth Offer", leadId: L, submissionId: sid, answers })),
    );
    assert.deepEqual(results.sort(), ["repeat", "sent"]);
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0].token, "1001:oasis-operator-token");
    assert.equal(calls[0].chatId, "5550001");
    assert.match(calls[0].text, /New lead from the offer page "Growth Offer"/);
    assert.match(calls[0].text, /Dana &amp; Co &lt;script&gt;/, "visitor-typed values are escaped for Telegram HTML");
    assert.match(calls[0].text, /no booking yet/);
    // A later step-0 by the same lead is a repeat.
    const later = await submission("s-race-c", OFFER_OASIS, OASIS, L, "2026-10-08T13:00:00.000Z");
    assert.equal(await notifyOfferLead({ db: supa, offers, tenantId: OASIS, formId: OFFER_OASIS, formName: "Growth Offer", leadId: L, submissionId: later, answers }), "repeat");
    assert.equal(calls.length, 1);
  });

  await step("a client workspace with no bot: nothing reaches OASIS's Telegram, and no failure marker", async () => {
    reset();
    const L = await lead(CLIENT_A, "Alex");
    const s = await submission("s-client-a", OFFER_A, CLIENT_A, L, "2026-10-08T12:00:00.000Z");
    const r = await notifyOfferLead({ db: supa, offers, tenantId: CLIENT_A, formId: OFFER_A, formName: "Spring Offer", leadId: L, submissionId: s, answers });
    assert.equal(r, "not_sent");
    assert.deepEqual(calls, [], "a client's lead alert left the client's workspace");
    const markers = await db.execute({ sql: "SELECT COUNT(*) AS n FROM lead_interactions WHERE lead_id = ?", args: [L] });
    assert.equal(Number(markers.rows[0].n), 0, "no bot connected is the workspace's choice, not a failure");
  });

  await step("a client workspace with its own bot: the alert reaches that bot and chat only", async () => {
    reset();
    const L = await lead(CLIENT_B, "Bea");
    const s = await submission("s-client-b", OFFER_B, CLIENT_B, L, "2026-10-08T12:00:00.000Z");
    const r = await notifyOfferLead({ db: supa, offers, tenantId: CLIENT_B, formId: OFFER_B, formName: "Smile Offer", leadId: L, submissionId: s, answers });
    assert.equal(r, "sent");
    assert.deepEqual(calls.map((c) => [c.token, c.chatId]), [["2002:client-b-own-bot", "-1009990002"]]);
    assert.deepEqual(toOasis(), []);
  });

  await step("a delivery that fails leaves a marker on the lead's timeline", async () => {
    reset();
    failingChats.add("5550001");
    const L = await lead(OASIS, "Failing");
    const s = await submission("s-fail", OFFER_OASIS, OASIS, L, "2026-10-08T12:00:00.000Z");
    const r = await notifyOfferLead({ db: supa, offers, tenantId: OASIS, formId: OFFER_OASIS, formName: "Growth Offer", leadId: L, submissionId: s, answers });
    assert.equal(r, "not_sent");
    const marker = await db.execute({ sql: "SELECT type, agent_source, content FROM lead_interactions WHERE lead_id = ?", args: [L] });
    assert.equal(marker.rows.length, 1);
    assert.equal(marker.rows[0].type, "alert_failed");
    assert.equal(marker.rows[0].agent_source, "offer_page_alert");
    assert.match(String(marker.rows[0].content), /chat not found/);
  });

  await step("the shared first-submission rule: the AI-audit alert and the offer alert agree on which racing submission is new", async () => {
    reset();
    const L = await lead(OASIS, "Shared");
    const a = await submission("s-shared-a", AUDIT, OASIS, L, "2026-10-08T12:00:00.000Z");
    const b = await submission("s-shared-b", AUDIT, OASIS, L, "2026-10-08T12:00:00.000Z");
    const verdict = async (sid: string) => isFirstSubmissionForLead({ db: supa, tenantId: OASIS, formId: AUDIT, leadId: L, submissionId: sid });
    assert.deepEqual([await verdict(a), await verdict(b)], [true, false]);
    // The AI-audit alert fires for exactly the submission the helper names.
    for (const sid of [b, a]) await notifyAiAuditStarted({ db: supa, tenantId: OASIS, formId: AUDIT, leadId: L, submissionId: sid, answers });
    assert.equal(calls.length, 1, "the AI-audit started alert fired once");
    assert.match(calls[0].text, /audit started/i);
    // And the offer alert, asked about the same two rows, agrees.
    const offerFor = async (sid: string) =>
      notifyOfferLead({ db: supa, offers, tenantId: OASIS, formId: AUDIT, formName: "AI Automation Audit", leadId: L, submissionId: sid, answers, push: async () => ({ delivered: true, outcome: "Sent to Telegram" }) });
    assert.deepEqual([await offerFor(a), await offerFor(b)], ["sent", "repeat"]);
    // One rule, one copy: the AI-audit alert has no query of its own any more.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/forms/ai-audit-notify.ts", "utf8");
    assert.match(src, /isFirstSubmissionForLead\(/);
    assert.doesNotMatch(src, /from\("form_submissions"\)/, "ai-audit-notify.ts carries its own copy of the first-submission query again");
  });

  // -- through the real submit route ---------------------------------------
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/forms/submit/route");
  let ip = 10;
  const submit = async (formSlug: string, payload: Record<string, unknown>) => {
    ip += 1;
    const res = await route.POST(
      new NextRequest("http://localhost/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${ip}` },
        body: JSON.stringify({ step_index: 0, anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: formSlug }, payload }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  await step("submit route: a generic OASIS offer alerts on the first step, once", async () => {
    reset();
    afterQueue.length = 0;
    const r = await submit("growth-offer", { name: "Rae Route", email: "rae@route.test", phone: "+15145550111", company: "Rae Roofing" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drainAfter();
    const offerAlerts = calls.filter((c) => /offer page "Growth Offer"/.test(c.text));
    assert.equal(offerAlerts.length, 1, JSON.stringify(calls.map((c) => c.text.slice(0, 60))));
    assert.equal(offerAlerts[0].chatId, "5550001");
  });

  await step("submit route: OASIS's ai-audit keeps its own alert and is not alerted twice", async () => {
    reset();
    afterQueue.length = 0;
    const r = await submit("ai-audit", { name: "Ann Audit", email: "ann@audit.test", phone: "+15145550122", company: "Ann Apps" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drainAfter();
    assert.equal(calls.filter((c) => /offer page/.test(c.text)).length, 0, "ai-audit got the generic offer alert too");
    assert.equal(calls.filter((c) => /audit started/i.test(c.text)).length, 1);
  });

  await step("submit route: a form with no offer page sends no offer alert", async () => {
    reset();
    afterQueue.length = 0;
    const r = await submit("plain", { name: "Pat Plain", email: "pat@plain.test", phone: "+15145550133", company: "Pat Paints" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drainAfter();
    assert.equal(calls.filter((c) => /offer page/.test(c.text)).length, 0);
  });

  done("offer-pages-notify");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
