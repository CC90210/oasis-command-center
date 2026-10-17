/**
 * No lead without a way to reach them (CC, 2026-10-16: "only leads that input
 * their information into these forms are getting logged into the pipeline. If
 * they don't input their email or phone number, then we do not need to store
 * them or log them").
 *
 * COMMUNITY asked two questions before its contact step, and the VSL router
 * never asks for contact at all, so every first click on either made a
 * pipeline lead with no name and no way to reach anyone. Now:
 *
 *   - the server refuses to create an anonymous lead without a valid email or
 *     phone, judged on step 0 plus the contact a later step hands over;
 *   - a held step 0 sent with its contact step's details creates the lead with
 *     them, and stores only step 0's own answers in step 0's row;
 *   - the router's answers come in one request that stores nothing and
 *     returns where to go next.
 *
 * Real route, real SQL (tests/_delivery-harness.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/forms-contact-gate.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, finish, OASIS, setupDatabase } from "./_delivery-harness";
import {
  contactGateAction,
  contactHandoff,
  hasReachableContact,
  isContactField,
  typedContact,
} from "../lib/forms/contact-gate";

// next/server's after() needs a request scope this harness doesn't open; the
// route's background alerts are not what this suite checks.
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

type Json = Record<string, unknown>;
const select = (name: string, options: string[], required = true) => ({
  name, type: "select", label: name, required, options: options.map((value) => ({ value, label: value })),
});
const text = (name: string, type: string, required = true) => ({ name, type, label: name, required });
const COMMUNITY_STEPS = [
  { key: "gate", title: "Two quick questions", fields: [select("free_self_serve", ["yes", "no"]), select("has_budget", ["yes", "no"])] },
  { key: "contact", title: "Where to send it", fields: [text("name", "text"), text("email", "email"), text("phone", "phone", false)] },
  { key: "upgrade", title: "One more", fields: [select("upgrade", ["yes", "no"], false)] },
];
// A form the builder made: its email and phone fields are named by their labels.
const CUSTOM_STEPS = [
  { key: "contact", title: "Reach you", fields: [text("full_name", "text"), text("work_email", "email", false), text("work_phone", "phone", false)] },
];
// An optional phone first, the email after (Codex review of #668): a visitor
// who leaves the phone blank gave no contact on step 0.
const PHONE_FIRST_STEPS = [
  { key: "about", title: "About you", fields: [text("name", "text"), text("phone", "phone", false)] },
  { key: "email", title: "Where to send it", fields: [text("email", "email")] },
];
// A router that asks for an email only on one path (Codex review of #668).
const BRANCH_STEPS = [
  {
    key: "path",
    title: "Which is you?",
    fields: [
      select("path", ["browse", "talk"]),
      { ...text("email", "email", false), show_if: { field: "path", equals: "talk" } },
    ],
  },
];
const VSL_STEPS = [
  { key: "path", title: "Which is you?", fields: [select("path", ["community", "audit"])] },
  { key: "budget", title: "Budget", fields: [select("budget", ["none_yet", "some"], false)] },
];

async function main() {
  const seed = await setupDatabase();
  // The router's destination lookup embeds the workspace (tenant:tenants), which
  // the adapter resolves through the foreign key the live table has; and the
  // router's rules live in forms.routing (bravo__220).
  await seed.executeMultiple(`
    DROP TABLE forms;
    CREATE TABLE forms (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, routing TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, target_agent TEXT,
      payload TEXT, correlation_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await seed.executeMultiple(readFileSync(join(__dirname, "..", "database", "turso", "bravo__214_consent_events.sql"), "utf8"));
  await seed.batch([
    {
      sql: "INSERT INTO forms (id, tenant_id, slug, name, steps, on_complete_stage) VALUES ('form-community', ?, 'community', 'COMMUNITY', ?, 'researched')",
      args: [OASIS, JSON.stringify(COMMUNITY_STEPS)],
    },
    {
      sql: "INSERT INTO forms (id, tenant_id, slug, name, steps, redirect_url) VALUES ('form-branch', ?, 'branch-router', 'Branch', ?, 'https://oasisai.work/thanks')",
      args: [OASIS, JSON.stringify(BRANCH_STEPS)],
    },
    {
      sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-phone-first', ?, 'phone-first', 'Phone first', ?)",
      args: [OASIS, JSON.stringify(PHONE_FIRST_STEPS)],
    },
    {
      sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-custom', ?, 'custom-contact', 'Custom', ?)",
      args: [OASIS, JSON.stringify(CUSTOM_STEPS)],
    },
    {
      sql: "INSERT INTO forms (id, tenant_id, slug, name, steps, redirect_url, routing) VALUES ('form-vsl', ?, 'vsl', 'Start here', ?, 'https://oasisai.work/thanks', ?)",
      args: [OASIS, JSON.stringify(VSL_STEPS), JSON.stringify([{ go: "community", when_any: [{ path: ["community"] }] }])],
    },
  ], "write");

  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/forms/submit/route");
  const count = async (sql: string) => Number((await seed.execute({ sql, args: [OASIS] })).rows[0].n);
  const leads = () => count("SELECT count(*) AS n FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead'");
  const rows = () => count("SELECT count(*) AS n FROM form_submissions WHERE tenant_id = ?");
  let ip = 0;
  const post = async (body: Json): Promise<{ status: number; json: Json }> => {
    ip += 1;
    const res = await route.POST(
      new NextRequest("http://localhost/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.8.0.${ip}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Json };
  };
  const anon = (formSlug: string) => ({ tenant_slug: "oasis-ai-cc", form_slug: formSlug });
  const gateAnswers = { free_self_serve: "no", has_budget: "yes" };

  console.log("forms-contact-gate:");

  await check("the shared rule: which fields ask for contact, and what counts as reachable", () => {
    assert.equal(isContactField({ name: "work_email", type: "email" }), true);
    assert.equal(isContactField({ name: "owner_cell", type: "text" }), true);
    assert.equal(isContactField({ name: "has_budget", type: "select" }), false);
    assert.equal(COMMUNITY_STEPS[0].fields.some(isContactField), false, "COMMUNITY's questions ask no contact");
    assert.equal(COMMUNITY_STEPS[1].fields.some(isContactField), true);
    assert.equal(VSL_STEPS.some((step) => step.fields.some(isContactField)), false, "the router never asks");
    assert.equal(hasReachableContact({ email: "ada@example.com" }), true);
    assert.equal(hasReachableContact({ phone: "+1 514 555 0142" }), true);
    assert.equal(hasReachableContact({ owner_cell: "(514) 555-0142" }), true);
    // Codex review of #668 (pass 4): letters are refused, never stripped into
    // digits; reachable means the consent ledger's canonical destination.
    for (const junk of [
      {}, { email: "nope" }, { email: "  " }, { phone: "123" }, { name: "Ada", company: "Acme" }, { email: 42 },
      { phone: "not-a-phone 12345678" }, { phone: "514 555 0142 ext 22" }, { email: "a b@example.com" },
    ]) {
      assert.equal(hasReachableContact(junk as Json), false, JSON.stringify(junk));
    }
    assert.deepEqual(
      contactHandoff({ name: " Ada ", email: "ada@example.com", stage: "won", revenue_band: "250k_plus", phone: 5145550142, company: "" }),
      { name: "Ada", email: "ada@example.com" },
      "only identity keys, only non-blank strings",
    );
    assert.equal(contactHandoff({ email: "x".repeat(400) })?.email.length, 320, "capped");
    for (const junk of [null, "ada@example.com", ["email"], { stage: "won" }]) assert.equal(contactHandoff(junk), null);
    // Codex review of #668: a builder-named field is read by its type.
    assert.deepEqual(
      typedContact(CUSTOM_STEPS[0].fields, { full_name: "Ada", work_email: " ada@example.com ", work_phone: "" }),
      { email: "ada@example.com" },
    );
    assert.deepEqual(typedContact(COMMUNITY_STEPS[0].fields, gateAnswers), {}, "a select is never contact");
    assert.deepEqual(
      contactHandoff({ ...typedContact(CUSTOM_STEPS[0].fields, { work_email: "ada@example.com" }), work_email: "ada@example.com" }),
      { email: "ada@example.com" },
      "the handoff carries a builder-named email under the standard name",
    );
  });

  await check("the browser holds until the visitor is reachable, routes when they never are, and sends normally after", () => {
    const act = (anonymous: boolean, reachable: boolean, currentStep: number, stepCount = 3, heldUnsent = false) =>
      contactGateAction({ anonymous, reachable, currentStep, stepCount, heldUnsent });
    assert.equal(act(true, false, 0), "hold", "COMMUNITY's questions wait for contact");
    assert.equal(act(true, true, 1, 3, true), "send-held", "the step that brings contact sends the held ones first");
    assert.equal(act(true, true, 0), "send", "a form that asks for contact first is unchanged");
    assert.equal(act(true, false, 0, 2), "hold", "the router's first step waits");
    assert.equal(act(true, false, 1, 2), "route", "the router's last step only asks where next");
    assert.equal(act(true, false, 2, 3), "route", "a contact form that never got contact asks too, and is told what is missing");
    // Codex review of #668 (pass 3): an optional phone left blank on step 0 is
    // no contact, so step 0 waits for the email on step 1 instead of being sent.
    assert.equal(act(true, false, 0, 2), "hold");
    assert.equal(act(true, true, 1, 2, true), "send-held");
    assert.equal(act(false, false, 1), "send", "a lead token means a lead already exists");
    // Codex review of #668: step 0 went through (a token now exists), a later
    // held step did not: the retry must finish the held steps, not skip them.
    assert.equal(act(false, true, 2, 4, true), "send-held");
    assert.equal(act(false, true, 2, 4, false), "send", "nothing held: the ordinary request");
  });

  await check("step 0 with no way to reach them creates nothing", async () => {
    const [leadsBefore, rowsBefore] = [await leads(), await rows()];
    for (const body of [
      { step_index: 0, anonymous_init: anon("community"), payload: gateAnswers },
      { step_index: 0, anonymous_init: anon("community"), payload: gateAnswers, contact: { email: "nope", phone: "123" } },
      { step_index: 0, anonymous_init: anon("community"), payload: gateAnswers, contact: { name: "Ada", company: "Acme" } },
      { step_index: 0, anonymous_init: anon("vsl"), payload: { path: "community" } },
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(res.json));
      assert.equal(res.json.error, "contact_required");
    }
    assert.equal(await leads(), leadsBefore, "a contactless click made a lead");
    assert.equal(await rows(), rowsBefore, "a contactless click stored answers");
  });

  await check("COMMUNITY: the held questions arrive with the contact step's details, then the contact step", async () => {
    const leadsBefore = await leads();
    const first = await post({
      step_index: 0,
      anonymous_init: anon("community"),
      payload: gateAnswers,
      contact: { name: "Ada Lovelace", email: "Ada@Example.com" },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const token = String(first.json.minted_token);
    assert.ok(token, "no lead token for the contact step");
    assert.equal(first.json.next_step, 1);
    assert.equal(await leads(), leadsBefore + 1);
    const lead = (await seed.execute({
      sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' ORDER BY created_at DESC LIMIT 1",
      args: [OASIS],
    })).rows[0];
    const data = JSON.parse(String(lead.data)) as Json;
    assert.equal(data.email, "ada@example.com", "the lead was created without its contact");
    assert.equal(data.name, "Ada Lovelace");
    const stepZero = (await seed.execute({
      sql: "SELECT payload FROM form_submissions WHERE tenant_id = ? AND lead_id = ? AND step_index = 0",
      args: [OASIS, String(lead.id)],
    })).rows;
    assert.equal(stepZero.length, 1);
    assert.deepEqual(JSON.parse(String(stepZero[0].payload)), gateAnswers, "step 0's row holds only step 0's answers");

    const second = await post({ step_index: 1, token, payload: { name: "Ada Lovelace", email: "ada@example.com" } });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.next_step, 2);
  });

  await check("a builder-named email or phone field counts, and the lead gets it (Codex review of #668)", async () => {
    const before = await leads();
    const ok = await post({ step_index: 0, anonymous_init: anon("custom-contact"), payload: { full_name: "Ada Custom", work_email: "ada.custom@example.com" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(await leads(), before + 1);
    const lead = (await seed.execute({
      sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' ORDER BY created_at DESC LIMIT 1",
      args: [OASIS],
    })).rows[0];
    assert.equal((JSON.parse(String(lead.data)) as Json).email, "ada.custom@example.com", "the lead was made without its builder-named email");
    const phoneOnly = await post({ step_index: 0, anonymous_init: anon("custom-contact"), payload: { full_name: "Pat Custom", work_phone: "514 555 0166" } });
    assert.equal(phoneOnly.status, 200, JSON.stringify(phoneOnly.json));
    const none = await post({ step_index: 0, anonymous_init: anon("custom-contact"), payload: { full_name: "Nobody", work_email: "nope" } });
    assert.equal(none.status, 400);
    assert.equal(none.json.error, "contact_required");
  });

  await check("an optional phone left blank is no contact: step 0 goes with the later email (Codex review of #668)", async () => {
    const before = await leads();
    const blank = await post({ step_index: 0, anonymous_init: anon("phone-first"), payload: { name: "Pat Blank", phone: "" } });
    assert.equal(blank.status, 400, "a blank optional phone made a lead");
    assert.equal(blank.json.error, "contact_required");
    const withEmail = await post({
      step_index: 0,
      anonymous_init: anon("phone-first"),
      payload: { name: "Pat Blank", phone: "" },
      contact: { name: "Pat Blank", email: "pat.blank@example.com" },
    });
    assert.equal(withEmail.status, 200, JSON.stringify(withEmail.json));
    assert.equal(await leads(), before + 1);
  });

  await check("a valid phone alone is enough", async () => {
    const before = await leads();
    const res = await post({ step_index: 0, anonymous_init: anon("community"), payload: gateAnswers, contact: { name: "Pat", phone: "(514) 555-0177" } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(await leads(), before + 1);
  });

  await check("the gate and the lead read the same field names (one list, contact-gate.ts)", async () => {
    // owner_cell is an alias the lead builder reads as the phone: the gate lets
    // it through only because it reads the same list, and the lead gets it.
    const res = await post({ step_index: 0, anonymous_init: anon("community"), payload: gateAnswers, contact: { owner_full_name: "Owen Alias", owner_cell: "(514) 555-0188" } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const lead = (await seed.execute({
      sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' ORDER BY created_at DESC LIMIT 1",
      args: [OASIS],
    })).rows[0];
    const data = JSON.parse(String(lead.data)) as Json;
    assert.equal(data.phone, "(514) 555-0188", "the gate passed a phone the lead never received");
    assert.equal(data.name, "Owen Alias");
    const route = readFileSync(join(__dirname, "..", "app", "api", "forms", "submit", "route.ts"), "utf8");
    for (const list of ["LEAD_NAME_KEYS", "LEAD_COMPANY_KEYS", "LEAD_EMAIL_KEYS", "LEAD_PHONE_KEYS"]) {
      assert.match(route, new RegExp(`trimmed\\(\\.\\.\\.${list}\\)`), `initAnonymousLead keeps its own copy of ${list}`);
    }
  });

  await check("the VSL router: answers in, a destination out, nothing stored", async () => {
    const [leadsBefore, rowsBefore] = [await leads(), await rows()];
    const routed = await post({
      step_index: 1,
      anonymous_init: anon("vsl"),
      route_only: true,
      steps_payload: [{ path: "community" }, { budget: "none_yet" }],
    });
    assert.equal(routed.status, 200, JSON.stringify(routed.json));
    assert.equal(routed.json.route_to, "/f/oasis-ai-cc/community", "the router's rule did not pick the destination");
    assert.equal(routed.json.next_step, null);
    const fallback = await post({ step_index: 1, anonymous_init: anon("vsl"), route_only: true, steps_payload: [{ path: "audit" }, {}] });
    assert.equal(fallback.status, 200, JSON.stringify(fallback.json));
    assert.equal(fallback.json.redirect_url, "https://oasisai.work/thanks");
    assert.equal(await leads(), leadsBefore, "the router made a lead");
    assert.equal(await rows(), rowsBefore, "the router stored answers");
  });

  await check("a contact field hidden by its condition never blocks the route; a shown one does (Codex review of #668)", async () => {
    const [leadsBefore, rowsBefore] = [await leads(), await rows()];
    const hidden = await post({ step_index: 0, anonymous_init: anon("branch-router"), route_only: true, steps_payload: [{ path: "browse" }] });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.json));
    assert.equal(hidden.json.redirect_url, "https://oasisai.work/thanks");
    const shown = await post({ step_index: 0, anonymous_init: anon("branch-router"), route_only: true, steps_payload: [{ path: "talk" }] });
    assert.equal(shown.status, 400);
    assert.equal(shown.json.error, "contact_required", "a visitor shown an email field skipped their lead");
    assert.equal(await leads(), leadsBefore);
    assert.equal(await rows(), rowsBefore);
  });

  await check("the router path is refused for a form with a contact step, a missing answer, or a lead token", async () => {
    const [leadsBefore, rowsBefore] = [await leads(), await rows()];
    // COMMUNITY's contact step is required, so the router path stops at it like
    // any submission would; a shown-but-optional one answers contact_required
    // (the branch-router check above).
    const contactForm = await post({ step_index: 2, anonymous_init: anon("community"), route_only: true, steps_payload: [gateAnswers, {}, {}] });
    assert.equal(contactForm.status, 400);
    assert.equal(contactForm.json.error, "missing_required_field", "a form that collects contact skipped its lead");
    const filledButNoContact = await post({
      step_index: 2,
      anonymous_init: anon("community"),
      route_only: true,
      steps_payload: [gateAnswers, { name: "No Contact", email: "not-an-email" }, {}],
    });
    assert.equal(filledButNoContact.status, 400);
    assert.equal(filledButNoContact.json.error, "contact_required", "a shown email field, filled with junk, skipped the lead");
    const blank = await post({ step_index: 1, anonymous_init: anon("vsl"), route_only: true, steps_payload: [{}, {}] });
    assert.equal(blank.status, 400);
    assert.equal(blank.json.error, "missing_required_field");
    const short = await post({ step_index: 1, anonymous_init: anon("vsl"), route_only: true, steps_payload: [{ path: "audit" }] });
    assert.equal(short.status, 400);
    assert.equal(short.json.error, "invalid_step_index");
    const tokened = await post({ step_index: 1, token: "x", anonymous_init: anon("vsl"), route_only: true, steps_payload: [{ path: "audit" }, {}] });
    assert.equal(tokened.status, 400);
    assert.equal(tokened.json.error, "route_only_requires_anonymous");
    assert.equal(await leads(), leadsBefore);
    assert.equal(await rows(), rowsBefore);
  });

  await check("the form holds, sends held steps with the contact, and routes, as the rule says", () => {
    // No DOM here: the decision itself is contactGateAction (tested above);
    // these pin that the form acts on each answer it gives.
    const client = readFileSync(join(__dirname, "..", "components", "forms", "FormPublicClient.tsx"), "utf8").replace(/\r\n/g, "\n");
    assert.match(
      client,
      /const answersSoFar: Record<string, unknown> = Object\.assign\(\s*\{\},\s*\.\.\.heldSteps\.current\.slice\(0, currentStep\)\.filter\(Boolean\),\s*built\.payload,\s*\);/,
      "reachability must read every answer so far, not one step",
    );
    assert.match(client, /const contactSoFar = \{ \.\.\.typedContact\(fieldsSoFar, answersSoFar\), \.\.\.answersSoFar \};/);
    assert.match(
      client,
      /anonymous: !tokenRef\.current && Boolean\(anonymousInit\),\s*reachable: hasReachableContact\(contactSoFar\),\s*currentStep,\s*stepCount: steps\.length,/,
      "the gate must decide by what the visitor gave, not where the field sits",
    );
    assert.match(client, /if \(gate === "route"\) \{\s*await routeWithoutLead\(built\.payload\);\s*return;/);
    assert.match(
      client,
      /if \(gate === "hold"\) \{\s*heldSteps\.current\[currentStep\] = built\.payload;[\s\S]{0,700}advanceFrom\(currentStep, currentStep \+ 1\);\s*return;/,
      "a held step must stay in the browser and move on, with no request",
    );
    assert.match(client, /heldUnsent: heldStepsSent\.current < Math\.min\(currentStep, heldSteps\.current\.length\),/, "a retry after a partial send skips the held steps");
    assert.match(
      client,
      /if \(gate === "send-held"\) \{[\s\S]{0,300}if \(!\(await sendHeldSteps\(contactHandoff\(contactSoFar\)\)\)\) return;/,
      "the held steps must carry the contact under the standard names",
    );
    // Codex review of #668: Back during the held-step send moved the consent
    // boxes off this step, so posting it then would drop its consent decision.
    assert.match(
      client,
      /if \(!\(await sendHeldSteps\(contactHandoff\(contactSoFar\)\)\)\) return;[\s\S]{0,500}if \(currentStepRef\.current !== stepAtStart\) return;\s*\}/,
      "the contact step posts after the visitor went Back mid-send",
    );
    assert.match(
      client,
      /if \(currentStep < heldSteps\.current\.length\) heldStepsSent\.current = Math\.max\(heldStepsSent\.current, currentStep \+ 1\);/,
      "a held step sent the ordinary way (after Back) would be sent again from its stale copy",
    );
    const held = client.slice(client.indexOf("async function sendHeldSteps"), client.indexOf("async function routeWithoutLead"));
    assert.match(held, /for \(let i = heldStepsSent\.current; i < currentStep; i \+= 1\)/, "a retry must resume after the last held step that went through");
    // Codex review of #668 (pass 3): before a lead exists, the failure report is
    // the only copy of the contact, and it must name the held step that failed.
    assert.match(held, /showSubmitFailure\(res, data, \{ \.\.\.payload, \.\.\.\(contact \?\? \{\}\) \}, i\);/);
    assert.match(client, /step_index: stepIndex,/, "the failure report stamps the step on screen, not the one that failed");
    // A held step's consent boxes (an optional phone left blank, an email not
    // yet valid) travel with it: the server binds each to that step's own field.
    assert.match(client, /heldLedgers\.current\[currentStep\] = consentLedgerFor\(stepAtStart\);/);
    assert.match(held, /const ledger = heldLedgers\.current\[i\];\s*if \(ledger\) body\.consent_ledger = ledger;/);
    assert.match(held, /if \(tokenRef\.current\) \{\s*body\.token = tokenRef\.current;\s*\} else \{\s*body\.anonymous_init = anonymousInit;\s*if \(contact\) body\.contact = contact;/);
    assert.match(held, /heldStepsSent\.current = i \+ 1;/);
    const route = client.slice(client.indexOf("async function routeWithoutLead"), client.indexOf("async function submit()"));
    assert.match(route, /route_only: true,\s*steps_payload: steps\.map\(\(_, i\) => \(i === currentStep \? lastPayload : heldSteps\.current\[i\] \?\? \{\}\)\),/);
    assert.match(client, /if \(tokenRef\.current \|\| token\) \{\s*submitBody\.token = tokenRef\.current \|\| token;/, "the contact step must use the token its held steps just minted");
    // onStepSubmitted means "the server accepted this step" (its contract):
    // never for a held step or the router, which store nothing (Codex review of #668).
    const holdBranch = client.slice(client.indexOf('if (gate === "hold") {'), client.indexOf('if (gate === "send-held") {'));
    assert.doesNotMatch(holdBranch, /onStepSubmitted\?\.\(/, "a held step told the offer page it was accepted");
    assert.doesNotMatch(route, /onStepSubmitted\?\.\(/, "the router told the offer page a step was accepted");
    assert.match(held, /heldStepsSent\.current = i \+ 1;\s*onStepSubmitted\?\.\(i, false\);/, "a held step the server accepted is not reported");
    const book = readFileSync(join(__dirname, "..", "components", "offer-pages", "OfferBook.tsx"), "utf8");
    assert.match(book, /onStepSubmitted=\{\(\) => \{[\s\S]{0,400}setContactDone\(true\);\s*\}\}/, "\"Your details are in\" before any details");
  });

  await check("both routing reads are scoped to the workspace (Codex review of #668)", () => {
    const route = readFileSync(join(__dirname, "..", "app", "api", "forms", "submit", "route.ts"), "utf8");
    const reads = route.match(/\.from\("forms"\)\s*\.select\("routing"\)\s*\.eq\("tenant_id", form\.tenant_id\)\s*\.eq\("id", form\.id\)/g) ?? [];
    assert.equal(reads.length, 2, "a routing read without its tenant filter");
    assert.doesNotMatch(route, /select\("routing"\)\.eq\("id"/);
  });

  await check("every new refusal has a sentence in the form", () => {
    const client = readFileSync(join(__dirname, "..", "components", "forms", "FormPublicClient.tsx"), "utf8");
    for (const code of ["contact_required", "route_only_requires_anonymous", "invalid_step_index"]) {
      assert.match(client, new RegExp(`\\b${code}:`), `${code} has no copy`);
    }
  });

  finish("forms-contact-gate");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
