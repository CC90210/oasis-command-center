/**
 * offer-pages-access.test.ts - who may build offer pages, and on which forms
 * (app/api/forms/[id]/offer/*), design sections 2.1 and 2.2.
 *
 * WHAT IS PINNED, on every builder route (GET/PUT offer, publish, unpublish,
 * video-link, library-videos):
 *   - signed out: 401;
 *   - a member who may not edit forms: 403 forbidden, with the same sentence
 *     the forms routes use (lib/forms/access.ts formsEditRefusal);
 *   - a retired workspace (SunBiz): 403 workspace_closed, its owner included;
 *   - another workspace's form id: 404, and nothing of it changes;
 *   - a support desk's form (OASIS's /support, and a client's registered
 *     desk): Turn into an offer answers 409 support_desk_form;
 *   - an owner of the workspace: makes the page (a draft), reads it back;
 *   - the line saying who hears of a new lead quotes the workspace's Telegram
 *     card in Connections (never set up, not tested, refused, passed).
 *
 * Real routes and sessions against a local libSQL file with bravo__203.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-access.test.ts
 */
import { AT, CLIENT_A, CLIENT_B, OASIS, USERS, done, formRow, login, setupOfferDatabase, step, CONTACT_STEPS, minimalDoc, offerRow } from "./_offer-pages-harness";
import assert from "node:assert/strict";

// A saved Telegram bot is stored encrypted (lib/field-encryption.ts).
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "offer-pages-access-field-key-material";

const FORM_A = "f0ac0000-0000-4000-8000-00000000000a";
const FORM_A_DESK = "f0ac0000-0000-4000-8000-0000000000de";
const FORM_B = "f0ac0000-0000-4000-8000-00000000000b";
const FORM_SUN = "f0ac0000-0000-4000-8000-00000000005e";
const SUN_OWNER = { id: "0e000000-0000-4000-8000-0000000000b1", email: "owner@sun.test" };

async function main() {
  const db = await setupOfferDatabase();
  const { SUNBIZ_RETIRED_TENANT_ID: SUN } = await import("../lib/tenant/retired");
  await db.executeMultiple(`CREATE TABLE support_desks (tenant_id TEXT PRIMARY KEY, form_id TEXT NOT NULL, enabled_by TEXT, enabled_at TEXT);`);
  await db.batch(
    [
      formRow(FORM_A, CLIENT_A, "growth", "A growth offer", CONTACT_STEPS),
      formRow(FORM_A_DESK, CLIENT_A, "support", "A support desk", CONTACT_STEPS.slice(0, 1)),
      { sql: "INSERT INTO support_desks (tenant_id, form_id, enabled_by, enabled_at) VALUES (?, ?, NULL, '2026-10-01')", args: [CLIENT_A, FORM_A_DESK] },
      formRow(FORM_B, CLIENT_B, "growth", "B growth offer", CONTACT_STEPS),
      offerRow({ formId: FORM_B, tenantId: CLIENT_B, draft: minimalDoc() }),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'SunBiz Funding')", args: [SUN] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [SUN_OWNER.id, SUN_OWNER.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES ('p-sun-owner', ?, ?, ?, 'owner', 1, '2026-09-01T00:00:00Z', 'Sun Owner', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [SUN_OWNER.id, SUN_OWNER.email, SUN],
      },
      formRow(FORM_SUN, SUN, "initial-lead-capture", "Initial Lead Capture", CONTACT_STEPS),
      // A client member who may not edit forms.
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES ('0e000000-0000-4000-8000-0000000000c1', 'member@client-a.test')`, args: [] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES ('p-a-member', '0e000000-0000-4000-8000-0000000000c1', 'member@client-a.test', ?, 'member', 0, '2026-09-01T00:00:00Z', 'Member', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [CLIENT_A],
      },
    ],
    "write",
  );
  const MEMBER_A = { id: "0e000000-0000-4000-8000-0000000000c1", email: "member@client-a.test" };
  const OASIS_SUPPORT = String(
    (await db.execute({ sql: "SELECT id FROM forms WHERE tenant_id = ? AND slug = 'support'", args: [OASIS] })).rows[0]?.id ?? "",
  );

  const { NextRequest } = await import("next/server");
  const access = await import("../lib/forms/access");
  const offer = await import("../app/api/forms/[id]/offer/route");
  const publish = await import("../app/api/forms/[id]/offer/publish/route");
  const unpublish = await import("../app/api/forms/[id]/offer/unpublish/route");
  const videoLink = await import("../app/api/forms/[id]/offer/video-link/route");
  const library = await import("../app/api/forms/[id]/offer/library-videos/route");
  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const p = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = async (r: Promise<Response> | Response) => {
    const res = await r;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const table = async () => JSON.stringify((await db.execute("SELECT * FROM form_offer_pages ORDER BY form_id")).rows);
  const routes = (id: string) =>
    [
      ["GET offer", () => offer.GET(req("GET", `/api/forms/${id}/offer`), p(id))],
      ["PUT offer", () => offer.PUT(req("PUT", `/api/forms/${id}/offer`, { template: "book_call" }), p(id))],
      ["publish", () => publish.POST(req("POST", `/api/forms/${id}/offer/publish`, { version: 0 }), p(id))],
      ["unpublish", () => unpublish.POST(req("POST", `/api/forms/${id}/offer/unpublish`), p(id))],
      ["video-link", () => videoLink.POST(req("POST", `/api/forms/${id}/offer/video-link`, { url: "https://youtu.be/dQw4w9WgXcQ" }), p(id))],
      ["library-videos", () => library.GET(req("GET", `/api/forms/${id}/offer/library-videos`), p(id))],
    ] as const;

  console.log("offer-pages-access:");

  await step("signed out: 401 on every builder route", async () => {
    await login(null);
    for (const [what, run] of routes(FORM_A)) assert.equal((await json(run())).status, 401, what);
  });

  await step("a member who may not edit forms: 403 forbidden, with the forms sentence, and nothing changes", async () => {
    await login(MEMBER_A);
    const before = await table();
    for (const [what, run] of routes(FORM_A)) {
      const r = await json(run());
      assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "forbidden", what);
      assert.equal(r.body.message, access.FORMS_EDIT_REFUSED, what);
    }
    assert.equal(await table(), before);
  });

  await step("a retired workspace: 403 workspace_closed for its owner too", async () => {
    await login(SUN_OWNER);
    for (const [what, run] of routes(FORM_SUN)) {
      const r = await json(run());
      assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "workspace_closed", what);
    }
  });

  await step("another workspace's form id: 404 on every route, and its page is untouched", async () => {
    await login(USERS.clientA);
    const before = await table();
    for (const [what, run] of routes(FORM_B)) {
      const r = await json(run());
      assert.equal(r.status, 404, `${what}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(await table(), before, "A changed B's offer page");
  });

  await step("a support desk's form never becomes an offer: 409 support_desk_form (a client's desk and OASIS's /support)", async () => {
    await login(USERS.clientA);
    const r = await json(offer.PUT(req("PUT", `/api/forms/${FORM_A_DESK}/offer`, { template: "free_audit" }), p(FORM_A_DESK)));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "support_desk_form");
    const g = await json(offer.GET(req("GET", `/api/forms/${FORM_A_DESK}/offer`), p(FORM_A_DESK)));
    assert.equal(g.body.offerable, false, "the editor does not offer Turn into an offer");
    assert.ok(OASIS_SUPPORT, "precondition: migration 183 seeded OASIS's support form");
    await login(USERS.cc);
    const o = await json(offer.PUT(req("PUT", `/api/forms/${OASIS_SUPPORT}/offer`, { template: "free_audit" }), p(OASIS_SUPPORT)));
    assert.equal(o.status, 409, JSON.stringify(o.body));
    const rows = await db.execute({ sql: "SELECT COUNT(*) AS n FROM form_offer_pages WHERE form_id IN (?, ?)", args: [FORM_A_DESK, OASIS_SUPPORT] });
    assert.equal(Number(rows.rows[0].n), 0);
  });

  await step("the workspace's owner makes the page: a draft, nothing live, read back with its checklist", async () => {
    await login(USERS.clientA);
    const made = await json(offer.PUT(req("PUT", `/api/forms/${FORM_A}/offer`, { template: "book_call" }), p(FORM_A)));
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.created, true);
    const again = await json(offer.PUT(req("PUT", `/api/forms/${FORM_A}/offer`, { draft: minimalDoc({ template: "free_audit" }), version: 0 }), p(FORM_A)));
    assert.equal(again.status, 400, "the template is fixed when the page is made");
    const got = await json(offer.GET(req("GET", `/api/forms/${FORM_A}/offer`), p(FORM_A)));
    assert.equal(got.status, 200);
    const view = got.body.offer as { status: string; live: boolean; draft: { template: string }; gate: { blockers: string[] } };
    assert.equal(view.status, "draft");
    assert.equal(view.live, false);
    assert.equal(view.draft.template, "book_call");
    assert.ok(view.gate.blockers.some((b) => /headline/.test(b)), "a new page asks for its headline before it can go live");
    assert.equal(got.body.library_available, false, "a client workspace attaches video by link (MKT-12)");
    const alert = got.body.alert as { connected: boolean; line: string };
    assert.equal(alert.connected, false);
    assert.match(alert.line, /No alert channel connected/);
    const lib = await json(library.GET(req("GET", `/api/forms/${FORM_A}/offer/library-videos`), p(FORM_A)));
    assert.deepEqual(lib.body, { ok: true, available: false, videos: [] });
  });

  // One answer per integration (#553): the builder's alert line is the
  // Telegram card's own status in Connections, quoted, never a second verdict
  // drawn from the saved fields alone.
  await step("the alert line says what Connections says about the workspace's Telegram bot, in the card's words", async () => {
    const { encryptField } = await import("../lib/field-encryption");
    const { loadWorkspaceConnectorStatus } = await import("../components/os/connections/connector-facts");
    const { clientAlertLine, offerAlertStatus } = await import("../lib/offer-pages/alert-status");
    await login(USERS.clientA);
    const line = async () => (await json(offer.GET(req("GET", `/api/forms/${FORM_A}/offer`), p(FORM_A)))).body.alert as { connected: boolean; line: string };
    const card = () => loadWorkspaceConnectorStatus(CLIENT_A, "telegram");
    await db.batch(
      [
        { sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'telegram', 'bot_token', ?)", args: [CLIENT_A, encryptField("3003:client-a-own-bot")] },
        { sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'telegram', 'chat_id', ?)", args: [CLIENT_A, encryptField("-1003330003")] },
      ],
      "write",
    );
    // Saved, never tested.
    let c = await card();
    assert.equal(c?.kind, "configured", JSON.stringify(c));
    let l = await line();
    assert.equal(l.connected, false);
    assert.ok(l.line.includes(`"${c!.label}"`), `the line does not quote the card: ${l.line}`);
    // The last Test failed: Telegram refused the token.
    await db.execute({
      sql: "UPDATE tenant_integration_credentials SET last_tested_at = ?, last_test_ok = 0, last_test_error = 'telegram_http_401' WHERE tenant_id = ?",
      args: [AT, CLIENT_A],
    });
    c = await card();
    assert.equal(c?.kind, "attention", JSON.stringify(c));
    l = await line();
    assert.equal(l.connected, false);
    assert.ok(l.line.includes(`"${c!.label}"`), `the line does not quote the card: ${l.line}`);
    assert.doesNotMatch(l.line, /alert your Telegram bot/, "a bot Telegram refused is said to be alerting");
    // The last Test passed.
    await db.execute({ sql: "UPDATE tenant_integration_credentials SET last_test_ok = 1, last_test_error = NULL WHERE tenant_id = ?", args: [CLIENT_A] });
    assert.equal((await card())?.kind, "connected");
    assert.deepEqual(await line(), { connected: true, line: "New leads alert your Telegram bot." });
    // A card that could not be read is never "no channel".
    assert.match(clientAlertLine(null).line, /Couldn't check/);
    const failing = await offerAlertStatus(CLIENT_A, async () => {
      throw new Error("read failed");
    });
    assert.deepEqual([failing.connected, /Couldn't check/.test(failing.line)], [false, true]);
    await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id = ?", args: [CLIENT_A] });
  });

  await step("a hand-made draft that changes its template or carries markup is refused with the path", async () => {
    await login(USERS.clientA);
    const r = await json(offer.PUT(req("PUT", `/api/forms/${FORM_A}/offer`, { draft: minimalDoc({ hero: { headline: "<img src=x>" } }), version: 0 }), p(FORM_A)));
    assert.equal(r.status, 400);
    assert.equal(r.body.path, "$.hero.headline");
  });

  done("offer-pages-access");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
