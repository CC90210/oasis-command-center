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
  firstContactStepIndex,
  hasReachableContact,
  isContactField,
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
    assert.equal(firstContactStepIndex(COMMUNITY_STEPS), 1);
    assert.equal(firstContactStepIndex(VSL_STEPS), -1);
    assert.equal(hasReachableContact({ email: "ada@example.com" }), true);
    assert.equal(hasReachableContact({ phone: "+1 514 555 0142" }), true);
    assert.equal(hasReachableContact({ owner_cell: "(514) 555-0142" }), true);
    for (const junk of [{}, { email: "nope" }, { email: "  " }, { phone: "123" }, { name: "Ada", company: "Acme" }, { email: 42 }]) {
      assert.equal(hasReachableContact(junk as Json), false, JSON.stringify(junk));
    }
    assert.deepEqual(
      contactHandoff({ name: " Ada ", email: "ada@example.com", stage: "won", revenue_band: "250k_plus", phone: 5145550142, company: "" }),
      { name: "Ada", email: "ada@example.com" },
      "only identity keys, only non-blank strings",
    );
    assert.equal(contactHandoff({ email: "x".repeat(400) })?.email.length, 320, "capped");
    for (const junk of [null, "ada@example.com", ["email"], { stage: "won" }]) assert.equal(contactHandoff(junk), null);
  });

  await check("the browser holds the steps before contact, routes a contactless form, and sends normally after", () => {
    const act = (anonymous: boolean, contactStep: number, currentStep: number, stepCount = 3) =>
      contactGateAction({ anonymous, contactStep, currentStep, stepCount });
    assert.equal(act(true, 1, 0), "hold", "COMMUNITY's questions wait for the contact step");
    assert.equal(act(true, 1, 1), "send-held", "the contact step sends them first");
    assert.equal(act(true, 1, 2), "send", "a later step with no token sends as it always did");
    assert.equal(act(true, 0, 0), "send", "a form that asks for contact first is unchanged");
    assert.equal(act(true, -1, 0, 2), "hold", "the router's first step waits");
    assert.equal(act(true, -1, 1, 2), "route", "the router's last step only asks where next");
    assert.equal(act(false, 1, 0), "send", "a lead token means a lead already exists");
    assert.equal(act(false, -1, 1, 2), "send");
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

  await check("a valid phone alone is enough", async () => {
    const before = await leads();
    const res = await post({ step_index: 0, anonymous_init: anon("community"), payload: gateAnswers, contact: { name: "Pat", phone: "(514) 555-0177" } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(await leads(), before + 1);
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

  await check("the router path is refused for a form with a contact step, a missing answer, or a lead token", async () => {
    const [leadsBefore, rowsBefore] = [await leads(), await rows()];
    const contactForm = await post({ step_index: 2, anonymous_init: anon("community"), route_only: true, steps_payload: [gateAnswers, {}, {}] });
    assert.equal(contactForm.status, 400);
    assert.equal(contactForm.json.error, "contact_required", "a form that collects contact skipped its lead");
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
