/**
 * The public form's honeypot (CC, 2026-10-16: "make sure our funnels are
 * secure"). Every public form ends with one text box no person sees or reaches
 * (components/forms/HoneypotField.tsx, lib/forms/honeypot.ts). Only a script that fills every
 * box puts anything there, and the client then sends it as `honeypot`. The
 * submit route answers that request like a finished form and does nothing:
 * no lead, no row, no token, no database read.
 *
 * Real route, real SQL (tests/_delivery-harness.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/forms-honeypot.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, finish, OASIS, setupDatabase } from "./_delivery-harness";
import { HONEYPOT_BODY_KEY, isHoneypotFilled, reportTrappedSubmission, trapValue } from "../lib/forms/honeypot";

// next/server's after() needs a request scope this harness doesn't open.
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
const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const CONTACT_STEPS = [
  {
    key: "contact",
    title: "Your details",
    fields: [
      { name: "name", type: "text", label: "Name", required: true },
      { name: "email", type: "email", label: "Email", required: true },
    ],
  },
  { key: "more", title: "One more", fields: [{ name: "goal", type: "select", label: "Goal", required: false, options: [{ value: "grow", label: "Grow" }] }] },
];
const VSL_STEPS = [{ key: "path", title: "Which is you?", fields: [{ name: "path", type: "select", label: "Path", required: true, options: [{ value: "community", label: "Community" }] }] }];
const TRAP = "http://cheap-pills.example";

async function main() {
  const seed = await setupDatabase();
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
  await seed.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__214_consent_events.sql"), "utf8"));
  await seed.batch([
    {
      sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-audit', ?, 'audit-like', 'Audit', ?)",
      args: [OASIS, JSON.stringify(CONTACT_STEPS)],
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
        headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${ip}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Json };
  };
  const anon = (formSlug: string, tenantSlug = "oasis-ai-cc") => ({ tenant_slug: tenantSlug, form_slug: formSlug });
  const contact = { name: "Ada Lovelace", email: "ada@example.com" };
  const DONE = { ok: true, submission_id: null, next_step: null, lead_stage: null, route_to: null, redirect_url: null, next_forms: [] };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  console.log("forms-honeypot:");

  await check("a filled honeypot on the contact step stores nothing and answers like a finished form", async () => {
    const [leadsBefore, rowsBefore] = [await leads(), await rows()];
    const trapped = await post({ step_index: 0, anonymous_init: anon("audit-like"), payload: contact, honeypot: TRAP });
    assert.equal(trapped.status, 200);
    assert.deepEqual(trapped.json, DONE, "the bot learned it was caught, or got a token");
    assert.equal(await leads(), leadsBefore, "a lead was created");
    assert.equal(await rows(), rowsBefore, "a form_submissions row was written");
    const line = warnings.find((w) => w.includes("honeypot filled"));
    assert.ok(line, "the drop was not logged");
    assert.ok(line.includes("audit-like") && !line.includes("ada@example.com") && !line.includes("cheap-pills"), `the log line carries the payload: ${line}`);
    // The control: the same request without the trap is a real lead.
    const real = await post({ step_index: 0, anonymous_init: anon("audit-like"), payload: contact });
    assert.equal(real.status, 200, JSON.stringify(real.json));
    assert.ok(typeof real.json.minted_token === "string", "the control did not create the lead");
    assert.equal(await leads(), leadsBefore + 1);
  });

  await check("an empty or whitespace honeypot is no trap", async () => {
    const before = await leads();
    for (const honeypot of ["", "   ", 42, null]) {
      const res = await post({ step_index: 0, anonymous_init: anon("audit-like"), payload: { ...contact, email: `ada+${ip}@example.com` }, honeypot });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.ok(typeof res.json.minted_token === "string", `honeypot ${JSON.stringify(honeypot)} dropped a person`);
    }
    assert.equal(await leads(), before + 4);
  });

  await check("the router, an upload-first start and a token step are dropped the same way", async () => {
    const [leadsBefore, rowsBefore] = [await leads(), await rows()];
    const routed = await post({ step_index: 0, anonymous_init: anon("vsl"), route_only: true, steps_payload: [{ path: "community" }] });
    assert.ok(String(routed.json.route_to).includes("/community"), `control: the router routes (${JSON.stringify(routed.json)})`);
    const trappedRoute = await post({ step_index: 0, anonymous_init: anon("vsl"), route_only: true, steps_payload: [{ path: "community" }], honeypot: TRAP });
    assert.deepEqual(trappedRoute.json, DONE, "a trapped router request was still routed");
    const init = await post({ step_index: 0, payload: {}, anonymous_init: anon("audit-like"), initialize_only: true, honeypot: TRAP });
    assert.deepEqual(init.json, DONE, "an upload-first start minted a token for a script");
    const token = await post({ step_index: 1, token: "not-a-real-token", payload: { goal: "grow" } });
    assert.equal(token.status, 400, "control: a bad token is refused");
    const trappedToken = await post({ step_index: 1, token: "not-a-real-token", payload: { goal: "grow" }, honeypot: TRAP });
    assert.deepEqual(trappedToken.json, DONE);
    assert.equal(await leads(), leadsBefore);
    assert.equal(await rows(), rowsBefore);
  });

  await check("the drop reads nothing: an unknown workspace is not even looked up", async () => {
    const missing = await post({ step_index: 0, anonymous_init: anon("audit-like", "no-such-workspace"), payload: contact });
    assert.notEqual(missing.status, 200, "control: an unknown workspace is refused");
    const trapped = await post({ step_index: 0, anonymous_init: anon("audit-like", "no-such-workspace"), payload: contact, honeypot: TRAP });
    assert.deepEqual(trapped.json, DONE);
    // Before handleSubmit, so before the support desk, the router and every
    // lead path in it (the support branch stays handleSubmit's first statement).
    const route = read("app/api/forms/submit/route.ts");
    const entry = route.slice(route.indexOf("export async function POST("));
    assert.match(entry, /const trapped = honeypotDrop\(req, rawBody\);\s*if \(trapped\) return trapped;\s*try \{\s*return await handleSubmit\(req,/, "the drop does not run before handleSubmit");
  });

  await check("a script cannot flood the log: a few lines a minute per IP, slugs cut short (Codex review of #671)", async () => {
    const before = warnings.length;
    const long = "x".repeat(500);
    for (let i = 0; i < 20; i += 1) {
      const res = await route.POST(
        new NextRequest("http://localhost/api/forms/submit", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
          body: JSON.stringify({ step_index: 0, anonymous_init: anon(long, long), honeypot: TRAP }),
        }),
      );
      assert.deepEqual(await res.json(), DONE, "a throttled log changed the script's answer");
    }
    const lines = warnings.slice(before).filter((w) => w.includes("honeypot filled"));
    assert.ok(lines.length >= 1 && lines.length <= 5, `${lines.length} log lines from one IP`);
    assert.ok(lines.every((l) => !l.includes("x".repeat(61))), "a script's slug reached the log uncut");
  });

  await check("every public form ends with the trap, which no person can see, reach or autofill", () => {
    const renderer = read("components/forms/FormRenderer.tsx");
    const at = renderer.indexOf("{trapRef ? <HoneypotField inputRef={trapRef} /> : null}");
    assert.ok(at > renderer.indexOf("{previewMode && ("), "the trap is not the form's last child (every field id after it would change)");
    assert.match(renderer.slice(at, renderer.indexOf("</form>", at)), /^\{trapRef \? <HoneypotField inputRef=\{trapRef\} \/> : null\}\s*$/, "something follows the trap inside the form");
    const trap = read("components/forms/HoneypotField.tsx");
    assert.match(trap, /aria-hidden="true"/);
    assert.match(trap, /position: "absolute", left: "-10000px"/, "hidden with display:none, which form-filling scripts skip");
    assert.match(trap, /tabIndex=\{-1\}/);
    assert.match(trap, /autoComplete="off"/);
    const name = /name="([^"]+)"/.exec(trap)?.[1] ?? "";
    assert.equal(name, "hp_website");
    assert.doesNotMatch(name, /name|mail|phone|tel|company|org|address|city|zip|postal/i, "browser autofill would fill a person's details into the trap");
    const fixture = read("tests/fixtures/offer-pages/form-only.html");
    assert.equal((fixture.match(/name="hp_website"/g) || []).length, 1, "the visitor's form does not render the trap once");
    assert.match(fixture, /name="hp_website"\/><\/label><\/div><\/form>/, "the trap is not the last thing in the visitor's form");
  });

  await check("the client sends what the trap holds on every request, latched", () => {
    assert.equal(HONEYPOT_BODY_KEY, "honeypot", "the client and the route disagree on the body key");
    const latch = { current: "" };
    const box = (value: string) => ({ value }) as HTMLInputElement;
    assert.equal(trapValue(null, latch), "", "no box, no trap");
    assert.equal(trapValue(box("   "), latch), "", "whitespace is not a trap");
    assert.equal(trapValue(box(" spam "), latch), "spam");
    assert.equal(trapValue(box(""), latch), "spam", "a box that re-renders empty on a later step cleared the trap");
    assert.equal(trapValue(null, latch), "spam");
    assert.equal(trapValue(box("x".repeat(500)), { current: "" }).length, 200, "uncapped");
    for (const v of ["spam", " x "]) assert.equal(isHoneypotFilled(v), true);
    for (const v of ["", "  ", 1, null, undefined, ["spam"], { a: 1 }]) assert.equal(isHoneypotFilled(v), false, JSON.stringify(v));
    const client = read("components/forms/FormPublicClient.tsx");
    assert.match(client, /trapRef=\{trapRef\}/, "the public form does not draw the trap");
    const meta = client.slice(client.indexOf("function submitMeta()"), client.indexOf("function submitMeta()") + 700);
    assert.match(meta, /const honeypot = trapValue\(trapRef\.current, trapLatch\);\s*if \(honeypot\) meta\[HONEYPOT_BODY_KEY\] = honeypot;/, "submitMeta does not carry the trap (held steps, the router and every step use it)");
    assert.match(read("app/api/forms/submit/route.ts"), /if \(!isHoneypotFilled\(b\.honeypot\)\) return null;/, "the route has its own rule for a filled trap");
  });

  await check("a trapped browser stops before consent, tracking, held steps and uploads (Codex review of #671)", () => {
    const client = read("components/forms/FormPublicClient.tsx");
    const submit = client.slice(client.indexOf("  async function submit() {"));
    const trapAt = submit.indexOf("const trapped = trapValue(trapRef.current, trapLatch);");
    assert.ok(trapAt > submit.indexOf("if (preview) {"), "the trapped stop is missing, or runs before the owner's preview");
    assert.match(submit.slice(trapAt), /^const trapped = trapValue\(trapRef\.current, trapLatch\);\s*if \(trapped\) \{\s*await reportTrappedSubmission\(/, "the stop does not run whenever the trap is filled");
    for (const effect of ["captureConsent(", "trackEvent(", "sendHeldSteps(", "routeWithoutLead(", "buildSubmitPayloadRef.current()"]) {
      const at = submit.indexOf(effect);
      assert.ok(at > 0 && trapAt < at, `a trapped script reaches ${effect}`);
    }
    assert.match(submit.slice(trapAt, trapAt + 600), /\.\.\.submitMeta\(\),[\s\S]*setDone\(true\);\s*return;/, "the trapped request does not tell the route, or the script does not see the thanks");
    const upload = client.slice(client.indexOf("const ensureUploadToken = useCallback("));
    assert.ok(
      upload.indexOf("if (trapValue(trapRef.current, trapLatch)) return null;") > 0 &&
        upload.indexOf("if (trapValue(trapRef.current, trapLatch)) return null;") < upload.indexOf("initialize_only: true"),
      "an upload-first start mints a lead for a filled trap",
    );
  });

  await check("reportTrappedSubmission sends the form's identity with the trap, and never throws", async () => {
    const realFetch = globalThis.fetch;
    const sent: Array<{ url: string; body: Json }> = [];
    try {
      globalThis.fetch = (async (url: string, init: { body: string }) => {
        sent.push({ url, body: JSON.parse(init.body) as Json });
        return new Response("{}");
      }) as unknown as typeof fetch;
      await reportTrappedSubmission({ anonymous_init: anon("audit-like"), step_index: 0 }, "spam");
      assert.deepEqual(sent, [{ url: "/api/forms/submit", body: { anonymous_init: anon("audit-like"), step_index: 0, honeypot: "spam" } }]);
      globalThis.fetch = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      await reportTrappedSubmission({ step_index: 0 }, "spam");
    } finally {
      globalThis.fetch = realFetch;
    }
    // The route answers a real request with that body by dropping it.
    const before = await leads();
    assert.deepEqual((await post(sent[0].body)).json, DONE);
    assert.equal(await leads(), before);
  });

  await check("/book carries the same trap and books nothing for it", () => {
    const page = read("components/booking/BookingPage.tsx");
    assert.match(page, /<HoneypotField inputRef=\{trapRef\} \/>\s*<\/form>/, "/book's form does not end with the trap");
    const submit = page.slice(page.indexOf("const submit = async () => {"));
    const trapAt = submit.indexOf("const honeypot = trapValue(trapRef.current, trapLatch);");
    assert.ok(trapAt > submit.indexOf("if (!validate()) return;"), "the trap is read before the details are checked");
    for (const effect of ["setBusy(true)", "consent_ledger:", 'fetch("/api/forms/booking"']) {
      assert.ok(trapAt < submit.indexOf(effect), `a trapped script reaches ${effect}`);
    }
    const trapped = submit.slice(trapAt, submit.indexOf("setBusy(true)"));
    assert.match(trapped, /^const honeypot = trapValue\(trapRef\.current, trapLatch\);\s*if \(honeypot\) \{/, "the stop does not run whenever the trap is filled");
    assert.match(
      trapped,
      /await reportTrappedSubmission\(\s*\{ anonymous_init: \{ tenant_slug: props\.tenantSlug, form_slug: props\.formSlug \}, step_index: 0 \},\s*honeypot,\s*\);/,
      "the route is not told",
    );
    assert.doesNotMatch(trapped, /payload|consent_ledger/, "a trapped request carries the visitor's answers");
    assert.match(trapped, /setLeftDetails\(true\);\s*return;/);
  });

  console.warn = realWarn;
  finish("forms-honeypot");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
