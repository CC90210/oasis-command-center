/**
 * ai-audit-flow.test.ts — the Free AI Audit end to end, on a real libSQL file
 * with the real migrations, against the permanent test prospect.
 *
 * lead → engagement → catalogue confirmed → profile → audit + proposal drafts
 * → submit (frozen) → PDF stored → Gate 2 filed → approved by the OWNER →
 * private link + one email → client view → Pay (one Stripe session, reused)
 * → Stripe confirms (and only then) → onboarding, twice, creating one of
 * everything → Active Client → a later refund is caught and flagged.
 *
 * Plus the refusals that matter: a non-owner approver, a dry run, a stale
 * write, a frozen version, a fixture price on a real proposal, a mismatched
 * payment, a bad link. Only the mailbox and Stripe are fakes (they record and
 * never send); everything else is the production code path.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-flow.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { CLIENT_A, OASIS, USERS, check, finish, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];
process.env.AI_AUDIT_LINK_SECRET = "ai-audit-flow-test-link-secret-000000000000001";

const LEAD = "7a000000-0000-4000-8000-000000000001";
const LEAD_B = "7a000000-0000-4000-8000-000000000002";
const LEAD_C = "7a000000-0000-4000-8000-000000000003";
const LEAD_D = "7a000000-0000-4000-8000-000000000004";
const NOW = () => new Date();

/** scripts/apply_turso_migration.py split_statements: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

async function apply(db: Client, file: string) {
  for (const stmt of splitStatements(readFileSync(join(process.cwd(), "database", "turso", file), "utf8"))) await db.execute(stmt);
}

async function seedLead(db: Client, id: string, stage: string, email: string) {
  await db.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, OASIS, JSON.stringify({ stage, company: "[TEST] OASIS Audit Fixture Co", name: "Test Owner", email, website: "https://oasisai.work/fixtures/audit-fixture-co.html", business_city: "Collingwood" })],
  });
}

async function leadStage(db: Client, id: string): Promise<string> {
  const r = await db.execute({ sql: "SELECT json_extract(data, '$.stage') AS s FROM tenant_records WHERE id = ?", args: [id] });
  return String(r.rows[0]?.s ?? "");
}

function fixtureDoc() {
  return {
    schema: "ai_audit_doc/v1",
    business: { name: "[TEST] OASIS Audit Fixture Co", type: "local_service", location: "Collingwood, ON" },
    prepared_for: { name: "Test Owner" },
    prepared_on: "2026-10-25",
    sections: {
      executive_overview: { paragraphs: [{ text: "Most enquiries wait until the next morning for a reply.", cites: ["f1"] }] },
      current_assessment: { paragraphs: [{ text: "Jobs are booked by phone and email.", cites: [] }], systems: [] },
      key_findings: { finding_ids: ["f1"] },
      inefficiencies: { items: [] },
      opportunities: {
        items: [
          { id: "o1", title: "Instant reply", what_it_does: "Replies at once with booking times.", problem: "Slow replies.", how_it_works: "A form triggers a reply.", integrations: ["Gmail"], expected_improvement: { text: "Saves 5 to 8 hours a month.", cites: ["e1"] }, finding_ids: ["f1"], estimate_ids: ["e1"] },
        ],
      },
      roadmap: { now: [{ opportunity_id: "o1", impact: "high", effort: "low", dependencies: [], urgency: "" }], next: [], later: [] },
      impact: { estimate_ids: ["e1"], limitations: ["Depends on lead volume."] },
      next_steps: { steps: ["Approve", "Kickoff"] },
    },
    findings: [{ id: "f1", title: "Replies take a day", statement: "The owner said replies go out the next morning.", label: "client_reported", source_ids: ["s1"] }],
    estimates: [{ id: "e1", title: "Time saved", formula: "enquiries x minutes", low: 5, high: 8, unit: "hours", period: "a month", inputs: [{ name: "Enquiries", value: 30, label: "client_reported", basis: "s1" }], assumptions: ["Ten minutes each."] }],
    sources: [{ id: "s1", kind: "client", title: "Discovery call" }],
    gaps: [],
  };
}

type FakeSession = { id: string; amount: number; currency: string; metadata: Record<string, string>; client_reference_id: string; paid: boolean; refunded: boolean; disputed: boolean; expired?: boolean; complete?: boolean };

function fakeStripe() {
  const sessions = new Map<string, FakeSession>();
  const created: Array<{ body: URLSearchParams; headers: Record<string, string> }> = [];
  let n = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === "https://api.stripe.com/v1/checkout/sessions" && init?.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      created.push({ body, headers: init.headers as Record<string, string> });
      n += 1;
      const id = `cs_live_fixture${n}`;
      const md: Record<string, string> = {};
      for (const [k, v] of body.entries()) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m) md[m[1]] = v;
      }
      sessions.set(id, { id, amount: Number(body.get("line_items[0][price_data][unit_amount]")), currency: String(body.get("line_items[0][price_data][currency]")), metadata: md, client_reference_id: String(body.get("client_reference_id")), paid: false, refunded: false, disputed: false });
      return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}`, livemode: true }), { status: 200 });
    }
    const x = /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_live_[A-Za-z0-9_]+)\/expire$/.exec(u);
    if (x && init?.method === "POST") {
      const s = sessions.get(x[1]);
      if (!s) return new Response(JSON.stringify({ error: { message: "No such session" } }), { status: 404 });
      // Stripe refuses to expire a completed session.
      if (s.paid || s.complete) return new Response(JSON.stringify({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }), { status: 400 });
      s.expired = true;
      return new Response(JSON.stringify({ id: s.id, status: "expired" }), { status: 200 });
    }
    const m = /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_live_[A-Za-z0-9_]+)/.exec(u);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return new Response(JSON.stringify({ error: { message: "No such session" } }), { status: 404 });
      return new Response(
        JSON.stringify({
          id: s.id,
          object: "checkout.session",
          livemode: true,
          status: s.paid || s.complete ? "complete" : s.expired ? "expired" : "open",
          payment_status: s.paid ? "paid" : "unpaid",
          amount_total: s.amount,
          currency: s.currency,
          client_reference_id: s.client_reference_id,
          metadata: s.metadata,
          payment_intent: s.paid ? { latest_charge: { refunded: s.refunded, amount_refunded: s.refunded ? s.amount : 0, disputed: s.disputed } } : null,
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { impl, sessions, created };
}

async function main() {
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of ["bravo__186_os_approvals.sql", "bravo__206_tool_jobs.sql", "bravo__240_meet_local_copies.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql", "bravo__241_ai_audit_briefs.sql"]) await apply(db, f);
  await seedLead(db, LEAD, "qualified", "owner@fixture.test");
  await seedLead(db, LEAD_B, "qualified", "second@fixture.test");
  await seedLead(db, LEAD_C, "qualified", "third@fixture.test");
  await seedLead(db, LEAD_D, "won", "fourth@fixture.test");

  const store = await import("../lib/ai-audit/store");
  const versions = await import("../lib/ai-audit/versions");
  const catStore = await import("../lib/ai-audit/catalogue-store");
  const lifecycle = await import("../lib/ai-audit/lifecycle");
  const delivery = await import("../lib/ai-audit/delivery");
  const pdf = await import("../lib/ai-audit/pdf");
  const link = await import("../lib/ai-audit/link");
  const pub = await import("../lib/ai-audit/public");
  const payment = await import("../lib/ai-audit/payment");
  const onboarding = await import("../lib/ai-audit/onboarding");
  const ownership = await import("../lib/ai-audit/ownership");
  const tick = await import("../lib/ai-audit/tick");
  const hash = await import("../lib/ai-audit/hash");
  const execute = await import("../lib/os/approvals/execute");
  const executors = await import("../lib/os/approvals/executors");
  const approvalsStore = await import("../lib/os/approvals/store");
  const authorize = await import("../lib/ai-audit/authorize");

  const cc = { type: "user" as const, id: USERS.cc.id };
  let engagementId = "";

  console.log("engagement");
  await check("opening an engagement is idempotent and moves nothing on the lead yet", async () => {
    const a = await store.openEngagement(db, { tenantId: OASIS, leadId: LEAD, actor: cc, now: NOW(), isFixture: true });
    assert.ok(a.ok && a.created);
    const b = await store.openEngagement(db, { tenantId: OASIS, leadId: LEAD, actor: cc, now: NOW() });
    assert.ok(b.ok && !b.created && a.ok && b.engagement.id === a.engagement.id);
    engagementId = a.ok ? a.engagement.id : "";
    assert.equal(a.ok && a.engagement.stage, "new_lead");
    assert.equal(await leadStage(db, LEAD), "qualified");
  });
  await check("a stage move updates the lead forward, and never backward", async () => {
    const m = await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId, to: "call_scheduled", actor: cc, now: NOW() });
    assert.ok(m.ok);
    assert.equal(await leadStage(db, LEAD), "founder_meeting_booked");
    const back = await lifecycle.moveLeadForward(db, { tenantId: OASIS, leadId: LEAD, target: "qualified", requestId: "test-back", actorUserId: USERS.cc.id, note: "x", now: NOW() });
    assert.equal(back.moved, false);
    assert.equal(back.reason, "lead_already_further");
  });
  await check("a stale row version writes nothing, the event included", async () => {
    const e = await store.getEngagement(db, OASIS, engagementId);
    const before = (await store.listEvents(db, OASIS, engagementId)).length;
    const r = await store.patchEngagement(db, { tenantId: OASIS, id: engagementId, expectedRowVersion: (e?.row_version ?? 0) - 1, patch: { contact_name: "Someone" }, event: "details_saved", actor: cc, now: NOW() });
    assert.equal(r.ok, false);
    assert.equal((await store.listEvents(db, OASIS, engagementId)).length, before);
  });
  await check("the audit trail refuses to be rewritten", async () => {
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_events SET event = 'tampered' WHERE tenant_id = ?", args: [OASIS] }), /append_only/);
  });

  console.log("catalogue and settings");
  let fixtureItemId = "";
  await check("the seed is proposed only; a confirmed price is final; confirming a new version retires the old", async () => {
    const seeded = await catStore.seedCatalogue(db, OASIS, USERS.cc.id, NOW(), { includeFixture: true });
    assert.ok(seeded.inserted > 10);
    assert.equal((await catStore.seedCatalogue(db, OASIS, USERS.cc.id, NOW(), { includeFixture: true })).inserted, 0, "seeding twice adds nothing");
    const all = await catStore.listCatalogue(db, OASIS, { includeFixture: true });
    assert.ok(all.every((i) => i.status === "proposed"));
    const fixture = all.find((i) => i.sku === "fixture-canary-item");
    assert.ok(fixture);
    fixtureItemId = fixture!.id;
    assert.ok((await catStore.confirmCatalogueItem(db, OASIS, fixtureItemId, USERS.cc.id, NOW())).ok);
    await assert.rejects(db.execute({ sql: "UPDATE ai_service_catalogue_items SET price_cents = 1 WHERE id = ?", args: [fixtureItemId] }), /final/);
    const real = all.find((i) => i.sku === "website-growth")!;
    assert.ok((await catStore.confirmCatalogueItem(db, OASIS, real.id, USERS.cc.id, NOW())).ok);
    const v2 = await catStore.proposeCatalogueVersion(db, OASIS, { ...real, price_cents: 520_000 }, USERS.cc.id, NOW());
    assert.equal(v2.item_version, 2);
    assert.ok((await catStore.confirmCatalogueItem(db, OASIS, v2.id, USERS.cc.id, NOW())).ok);
    const after = (await catStore.listCatalogue(db, OASIS)).filter((i) => i.sku === "website-growth");
    assert.deepEqual(after.map((i) => [i.item_version, i.status]), [[2, "confirmed"], [1, "retired"]]);
  });
  await check("settings: the tax rule starts unset and saves with a row version", async () => {
    const s = await store.getSettings(db, OASIS);
    assert.equal(s.settings.tax, null);
    const saved = await store.saveSettings(db, { tenantId: OASIS, settings: { ...s.settings, tax: { mode: "not_registered" } }, expectedRowVersion: 0, actorId: USERS.cc.id, now: NOW() });
    assert.ok(saved.ok);
    assert.equal((await store.saveSettings(db, { tenantId: OASIS, settings: s.settings, expectedRowVersion: 0, actorId: USERS.cc.id, now: NOW() })).ok, false);
  });

  console.log("drafts");
  await check("profile fields save on a draft, and a change to a transcript value is recorded as a correction", async () => {
    await versions.saveProfileField(db, { tenantId: OASIS, engagementId, field: { field_key: "sales.leads_per_month", value: 30, label: "client_reported", source_type: "transcript" }, actor: cc, now: NOW() });
    const f = await versions.saveProfileField(db, { tenantId: OASIS, engagementId, field: { field_key: "sales.leads_per_month", value: 35, label: "client_reported", source_type: "owner" }, actor: cc, now: NOW() });
    assert.equal(f.owner_corrected, true);
    assert.equal(f.source_type, "transcript");
    assert.equal(f.corrected_from, 30);
  });
  await check("the proposal takes the catalogue's confirmed price, whatever the browser sent; a fixture item never prices a real client", async () => {
    let e = (await store.getEngagement(db, OASIS, engagementId))!;
    const a = await versions.saveAuditDraft(db, { tenantId: OASIS, engagementId, doc: fixtureDoc() as never, actor: cc, now: NOW(), expectedRowVersion: e.row_version });
    assert.ok(a.ok);
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    const content = {
      schema: "ai_audit_proposal/v1",
      currency: "CAD",
      lines: [{ kind: "catalogue", line_id: "l1", sku: "fixture-canary-item", item_id: fixtureItemId, item_version: 1, name: "tampered", description: "", category: "implementation", unit: "fixed", quantity: 1, optional: false, unit_price_cents: 999_999, currency: "CAD", deliverables: [], onboarding_requirements: [] }],
      phases: [],
      payment_terms: { kind: "full" },
      tax: null,
      exclusions: [],
      terms: [],
      valid_until: "2099-01-01",
      delivery_email: { to: "owner@fixture.test", subject: "Your free AI audit", body: "Hi,\n\n{{audit_link}}\n\nThanks." },
    };
    const { settings } = await store.getSettings(db, OASIS);
    const p = await versions.saveProposalDraft(db, { tenantId: OASIS, engagementId, content: content as never, actor: cc, now: NOW(), expectedRowVersion: e.row_version, tax: settings.tax });
    assert.ok(p.ok);
    assert.equal(p.ok && p.version.content?.lines[0].kind, "catalogue");
    assert.equal(p.ok && (p.version.content?.lines[0] as { unit_price_cents: number }).unit_price_cents, 100, "the confirmed price, not the browser's");
    assert.equal(p.ok && p.version.total_cents, 100);
    // The same fixture item on a real client's engagement becomes "needs your price".
    const real = await store.openEngagement(db, { tenantId: OASIS, leadId: LEAD_B, actor: cc, now: NOW() });
    assert.ok(real.ok);
    const rp = await versions.saveProposalDraft(db, { tenantId: OASIS, engagementId: real.ok ? real.engagement.id : "", content: content as never, actor: cc, now: NOW(), expectedRowVersion: real.ok ? real.engagement.row_version : 0, tax: settings.tax });
    assert.equal(rp.ok && rp.version.content?.lines[0].kind, "needs_owner_price");
  });
  await check("only the owner types a price; a price the owner set survives anyone's later save (review of PR #732)", async () => {
    const realId = (await store.getOpenEngagementForLead(db, OASIS, LEAD_B))!.id;
    const { settings } = await store.getSettings(db, OASIS);
    const custom = async (price: number, setBy = "") => ({
      ...(await versions.getProposalVersion(db, OASIS, (await store.getEngagement(db, OASIS, realId))!.current_proposal_version_id!))!.content!,
      lines: [{ kind: "owner_set", line_id: "c1", name: "Custom build", description: "", category: "implementation", unit: "fixed", quantity: 1, optional: false, unit_price_cents: price, set_by: setBy, set_at: setBy ? "2026-10-25T00:00:00Z" : "", deliverables: [], onboarding_requirements: [] }],
    });
    const rv = async () => (await store.getEngagement(db, OASIS, realId))!.row_version;
    const byAdmin = await versions.saveProposalDraft(db, { tenantId: OASIS, engagementId: realId, content: (await custom(250_000)) as never, actor: { type: "user", id: USERS.admin.id }, now: NOW(), expectedRowVersion: await rv(), tax: settings.tax, ownerMayPrice: false });
    assert.equal(byAdmin.ok && byAdmin.version.content?.lines[0].kind, "needs_owner_price", "an admin's typed price waits for the owner");
    const byOwner = await versions.saveProposalDraft(db, { tenantId: OASIS, engagementId: realId, content: (await custom(250_000)) as never, actor: cc, now: NOW(), expectedRowVersion: await rv(), tax: settings.tax, ownerMayPrice: true });
    const line = byOwner.ok ? byOwner.version.content?.lines[0] : null;
    assert.equal(line?.kind, "owner_set");
    assert.equal((line as { set_by?: string } | null)?.set_by, USERS.cc.id, "stamped with who set it");
    const ownerContent = byOwner.ok ? byOwner.version.content! : (null as never);
    const keep = await versions.saveProposalDraft(db, { tenantId: OASIS, engagementId: realId, content: ownerContent as never, actor: { type: "user", id: USERS.admin.id }, now: NOW(), expectedRowVersion: await rv(), tax: settings.tax, ownerMayPrice: false });
    assert.equal(keep.ok && keep.version.content?.lines[0].kind, "owner_set", "the owner's unchanged price is kept");
    const fixtureItem = (await catStore.listCatalogue(db, OASIS, { includeFixture: true })).find((i) => i.is_fixture && i.status === "confirmed")!;
    const usd = await versions.normalizeProposal(
      db,
      OASIS,
      { ...ownerContent, currency: "USD", lines: [{ kind: "catalogue", line_id: "x1", sku: fixtureItem.sku, item_id: fixtureItem.id, item_version: fixtureItem.item_version, name: fixtureItem.name, description: "", category: fixtureItem.category, unit: fixtureItem.unit, quantity: 1, optional: false, unit_price_cents: 1, currency: "USD", deliverables: [], onboarding_requirements: [] }] } as never,
      null,
      USERS.cc.id,
      settings.tax,
      NOW(),
      { allowFixtureItems: true, ownerMayPrice: true },
    );
    assert.equal(usd.lines[0].kind, "needs_owner_price", "a CAD catalogue item never prices a USD proposal");
  });

  console.log("submit and the PDF");
  await check("submission refuses an unready engagement, then freezes both versions and queues the print", async () => {
    let e = (await store.getEngagement(db, OASIS, engagementId))!;
    const early = await delivery.submitForFinalApproval(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version, actor: cc, now: NOW() });
    assert.equal(early.ok, false, "call_scheduled is too early");
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId, to: "call_completed", actor: cc, now: NOW() })).ok);
    // Gate 1 (phase 2): the owner authorizes the profile; only then is submission possible.
    const asked = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId, actor: cc, now: NOW(), engine: "none" });
    assert.ok(asked.ok && asked.created, !asked.ok ? asked.error : "");
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.stage, "transcript_review");
    const notYet = await delivery.submitForFinalApproval(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version, actor: cc, now: NOW() });
    assert.equal(notYet.ok, false, "no submission before Gate 1");
    const authId = asked.ok ? asked.approvalId : "";
    await db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", args: [USERS.cc.id, new Date().toISOString(), authId] });
    const authed = await execute.executeApproval(db, { tenantId: OASIS, approvalId: authId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, executors.defaultExecutorDeps() as never);
    assert.equal(authed.ok && (authed.approval.execution_result as { outcome?: string } | null)?.outcome, "authorized");
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.stage, "generating");
    const r = await delivery.submitForFinalApproval(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version, actor: cc, now: NOW() });
    assert.ok(r.ok, !r.ok ? `${r.error} ${(r.problems ?? []).join("; ")}` : "");
    assert.equal(r.ok && r.audit.status, "awaiting_approval");
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_versions SET content = '{}' WHERE id = ?", args: [r.ok ? r.audit.id : ""] }), /frozen/);
    const jobs = await db.execute({ sql: "SELECT tool_key, status, input_json FROM tool_jobs WHERE tenant_id = ?", args: [OASIS] });
    assert.equal(jobs.rows.length, 1);
    assert.equal(String(jobs.rows[0].tool_key), "ai_audit_pdf");
    assert.ok(!String(jobs.rows[0].input_json).includes("sig="), "the job holds no usable address");
    assert.equal(await leadStage(db, LEAD), "demo_completed");
  });
  const stored = new Map<string, Uint8Array>();
  const memStorage = { upload: async (p: string, b: Uint8Array) => (stored.set(p, b), { ok: true as const }), download: async (p: string) => stored.get(p) ?? null };
  await check("a printed PDF is stored only if it is a PDF, matches its hash, and is still the version printed", async () => {
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    const audit = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    const bytes = Buffer.from("%PDF-1.4\n" + "x".repeat(400) + "\n%%EOF");
    const report = { pdfBase64: bytes.toString("base64"), sha256: hash.sha256Hex(bytes), bytes: bytes.length, pages: 6 };
    const jobInput = { audit_version_id: audit.id, content_sha256: audit.content_sha256 };
    const bad = await pdf.storePdf(db, memStorage, { tenantId: OASIS, jobInput, report: { ...report, sha256: "0".repeat(64) }, now: NOW() });
    assert.equal(bad.ok, false);
    const wrongVersion = await pdf.storePdf(db, memStorage, { tenantId: OASIS, jobInput: { ...jobInput, content_sha256: "f".repeat(64) }, report, now: NOW() });
    assert.equal(wrongVersion.ok, false);
    const good = await pdf.storePdf(db, memStorage, { tenantId: OASIS, jobInput, report, now: NOW() });
    assert.ok(good.ok);
    assert.equal((await versions.getAuditVersion(db, OASIS, audit.id))!.pdf_sha256, report.sha256);
  });

  console.log("Gate 2: final approval");
  let approvalId = "";
  await check("Gate 2 is filed once the PDF exists, bound to every hash, and only once", async () => {
    const r = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW() });
    assert.ok(r.ok && r.created);
    approvalId = r.ok ? r.approvalId : "";
    const again = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW() });
    assert.ok(again.ok && !again.created && again.approvalId === approvalId);
    const a = (await approvalsStore.getApprovalInTenant(db, OASIS, approvalId))!;
    assert.equal(a.action_kind, "deliver_ai_audit");
    assert.equal(a.department_key, null, "only owners and admins see it");
    assert.equal(a.risk_level, "spend");
  });

  const sent: Array<Record<string, unknown>> = [];
  const deliveryAlerts: Array<Record<string, unknown>> = [];
  const deps = (opts: { live: boolean; owner?: boolean } = { live: true }) => ({
    ...executors.defaultExecutorDeps(),
    isDryRun: (ch?: string) => (ch === "ai_audit_delivery" ? !opts.live : true),
    sendEmail: async (args: Record<string, unknown>) => {
      sent.push(args);
      return { ok: true as const, provider: "oasis_shared_gmail" as const, gmail_message_id: `m${sent.length}`, from_address: "submissions@oasisai.work" };
    },
    signerFor: () => null,
    publishEvent: async () => undefined,
    aiAudit: {
      linkSecret: () => process.env.AI_AUDIT_LINK_SECRET ?? null,
      baseUrl: () => "https://oasisai.work",
      stripeConnected: async () => true,
      isOwner: delivery.defaultAiAuditExecutorDeps().isOwner,
      readPdf: async (path: string) => stored.get(path) ?? null,
      alert: async (a: Record<string, unknown>) => void deliveryAlerts.push(a),
    },
  });
  const approve = async () => db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status IN ('pending', 'failed')", args: [USERS.cc.id, new Date().toISOString(), approvalId] });
  await check("an admin who is not the owner cannot pass Gate 2: nothing is sent", async () => {
    await approve();
    const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: USERS.admin.id, email: USERS.admin.email } }, deps() as never);
    assert.ok(r.ok);
    assert.equal(r.ok && r.approval.status, "failed");
    assert.equal(sent.length, 0);
    assert.equal(await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_share_links", args: [] }).then((x) => Number(x.rows[0].n)), 0);
  });
  await check("a retry files a fresh card; in dry run nothing is minted or sent", async () => {
    const retry = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW(), retry: true });
    assert.ok(retry.ok && retry.created);
    approvalId = retry.ok ? retry.approvalId : "";
    await approve();
    const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps({ live: false }) as never);
    assert.equal(r.ok && (r.approval.execution_result as { outcome?: string } | null)?.outcome, "dry_run");
    assert.equal(sent.length, 0);
    assert.equal((await store.getEngagement(db, OASIS, engagementId))!.stage, "final_review");
  });
  await check("an uncertain send keeps its link and offers no second send until CC checks the Sent folder", async () => {
    const retry = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW(), retry: true });
    approvalId = retry.ok ? retry.approvalId : "";
    await approve();
    const unsure = { ...deps(), sendEmail: async () => ({ ok: false as const, provider: "oasis_shared_gmail" as const, reason: "delivery_unknown" as const, error: "the server stopped answering" }) };
    const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, unsure as never);
    assert.equal(r.ok && (r.approval.execution_result as { reason?: string } | null)?.reason, "delivery_unknown");
    const live = await link.linkForApproval(db, OASIS, approvalId);
    assert.ok(live && !live.revoked_at, "the link the email may carry still works");
    assert.equal(deliveryAlerts.at(-1)?.alertType, "ai_audit_delivery_unknown");
    const blind = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW(), retry: true });
    assert.deepEqual(blind, { ok: false, error: "delivery_unknown_check_sent" }, "no plain retry");
    deliveryAlerts.length = 0;
  });
  await check("CC says it was not sent: the old link dies and a fresh card is filed", async () => {
    const oldApproval = approvalId;
    const retry = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW(), retry: true, confirmNotSent: true });
    assert.ok(retry.ok && retry.created);
    approvalId = retry.ok ? retry.approvalId : "";
    assert.ok((await link.linkForApproval(db, OASIS, oldApproval))?.revoked_at, "the uncertain email's link is revoked");
  });
  await check("Gate 2 refuses when the approved PDF is missing from storage: nothing is minted or sent", async () => {
    await approve();
    const saved = [...stored.entries()];
    stored.clear();
    try {
      const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps() as never);
      assert.equal(r.ok && r.approval.status, "failed");
      assert.equal(r.ok && (r.approval.execution_result as { reason?: string } | null)?.reason, "pdf_missing");
      assert.equal(sent.length, 0);
    } finally {
      for (const [k, v] of saved) stored.set(k, v);
    }
  });
  await check("Gate 2 refuses once Gate 1 no longer holds: nothing is minted or sent (Codex review of phase 2)", async () => {
    await approve();
    // A transcript the authorization never covered, as a delete after submission leaves the set different from the one CC authorized.
    const at = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO ai_audit_transcripts (id, tenant_id, engagement_id, source, format, lines_json, line_count, char_count, speakers_json, text_sha256, redactions,
              consent_recording, consent_ai, consent_basis, consent_by, consent_at, status, created_by, created_at)
            VALUES ('voids-gate-1', ?, ?, 'paste', 'txt', '[]', 0, 0, '[]', ?, 0, 1, 1, 'owner_attested', ?, ?, 'active', ?, ?)`,
      args: [OASIS, engagementId, "f".repeat(64), USERS.cc.id, at, USERS.cc.id, at],
    });
    try {
      const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps() as never);
      assert.equal(r.ok && r.approval.status, "failed");
      assert.equal(r.ok && (r.approval.execution_result as { reason?: string } | null)?.reason, "not_authorized");
      assert.equal(sent.length, 0);
      const refile = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW(), retry: true });
      assert.deepEqual(refile, { ok: false, error: "not_authorized" }, "no new card either");
      assert.equal((await store.getEngagement(db, OASIS, engagementId))!.health, "attention");
    } finally {
      await db.execute("DELETE FROM ai_audit_transcripts WHERE id = 'voids-gate-1'");
    }
  });
  let token = "";
  await check("the owner's approval mints the private link, sends ONE email, and delivers", async () => {
    const retry = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW(), retry: true });
    approvalId = retry.ok ? retry.approvalId : "";
    await approve();
    // The write after the send fails (review of PR #732): the outcome must still be "sent",
    // so nobody retries into a second email, and the tick finishes the record.
    await db.execute("CREATE TRIGGER fail_delivered_event BEFORE INSERT ON ai_audit_events WHEN NEW.event = 'delivered' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    // While the send runs (the approval is executing), Reopen and a stage move by hand wait their turn:
    // the send already checked the versions and the authorization they would change (Codex review of phase 2, second pass).
    const during: string[] = [];
    const base = deps();
    const inFlight = {
      ...base,
      aiAudit: {
        ...base.aiAudit,
        readPdf: async (path: string) => {
          const e = (await store.getEngagement(db, OASIS, engagementId))!;
          const reopened = await delivery.reopenForEdits(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version, actor: cc, now: NOW() });
          during.push(reopened.ok ? "reopened" : reopened.error);
          const moved = await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId, to: "cancelled", actor: cc, now: NOW(), expectedRowVersion: e.row_version, event: "stage_set_by_owner", unlessDeliveryInFlight: true });
          during.push(moved.ok ? "moved" : moved.error);
          return stored.get(path) ?? null;
        },
      },
    };
    const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, inFlight as never);
    await db.execute("DROP TRIGGER fail_delivered_event");
    assert.deepEqual(during, ["delivery_in_progress", "delivery_in_progress"]);
    assert.equal(r.ok && (r.approval.execution_result as { outcome?: string } | null)?.outcome, "sent");
    assert.equal(sent.length, 1);
    assert.equal((await store.getEngagement(db, OASIS, engagementId))!.stage, "final_review", "not yet recorded");
    assert.equal(deliveryAlerts.length, 1);
    assert.equal(deliveryAlerts[0].alertType, "ai_audit_delivery_unrecorded");
    const notAgain = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW() });
    assert.ok(notAgain.ok && !notAgain.created && notAgain.approvalId === approvalId, "a sent approval is never re-filed");
    const repaired = await tick.runAiAuditTick(db, { budgetMs: 30_000, deps: { payment: { stripeSecret: async () => null, isDryRun: () => true, alert: async () => undefined, baseUrl: () => "https://oasisai.work" }, onboarding: { alert: async () => undefined, baseUrl: () => "https://oasisai.work" } } });
    assert.equal(repaired.deliveriesRepaired, 1);
    assert.equal(sent.length, 1, "the repair sends nothing");
    const body = String(sent[0].body);
    const m = /\/your-audit\/([A-Za-z0-9_-]{43})/.exec(body);
    assert.ok(m, "the email carries the private link");
    token = m![1];
    assert.ok(!body.includes("{{audit_link}}"));
    assert.equal(sent[0].to, "owner@fixture.test");
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.stage, "delivered");
    assert.equal((await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!.status, "delivered");
    assert.equal(await leadStage(db, LEAD), "proposal_sent");
    const stored2 = await db.execute({ sql: "SELECT token_sha256 FROM ai_audit_share_links WHERE tenant_id = ? AND approval_id = ?", args: [OASIS, approvalId] });
    assert.equal(String(stored2.rows[0].token_sha256), link.tokenHash(token));
    assert.ok(!JSON.stringify(stored2.rows).includes(token), "the token itself is never stored");
    // Pressing approve again runs nothing a second time.
    const again = await execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps() as never);
    assert.equal(again.ok, false);
    assert.equal(sent.length, 1);
  });


  console.log("a stalled audit's follow-up (phase 5)");
  await check("a stall files one follow-up for CC's approval; nothing is sent until the owner approves, and it resends the same link", async () => {
    const followUp = await import("../lib/ai-audit/follow-up");
    const later = new Date(Date.now() + 4 * 86_400_000);
    const tickDeps = { payment: { stripeSecret: async () => null, isDryRun: () => true, alert: async () => undefined, baseUrl: () => "https://oasisai.work" }, onboarding: { alert: async () => undefined, baseUrl: () => "https://oasisai.work" } };
    const rep = await tick.runAiAuditTick(db, { budgetMs: 30_000, now: () => later, deps: tickDeps as never });
    assert.equal(rep.stallsFlagged, 1, JSON.stringify(rep.errors));
    assert.equal(rep.followUpsFiled, 1);
    const card = (await db.execute({ sql: "SELECT id, status, risk_level, payload_json FROM approvals WHERE tenant_id = ? AND action_kind = 'follow_up_ai_audit'", args: [OASIS] })).rows;
    assert.equal(card.length, 1, "one card");
    assert.equal(String(card[0].risk_level), "outbound");
    const payload = JSON.parse(String(card[0].payload_json)) as Record<string, unknown>;
    assert.equal(payload.reason, "not_opened");
    assert.ok(String(payload.body).includes("{{audit_link}}") && !String(payload.body).includes(token), "the link is never stored, only its place");
    assert.equal(sent.length, 1, "nothing sent by the tick");
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    const link0 = (await link.getShareLink(db, OASIS, e.share_link_id!))!;
    assert.equal(await followUp.fileFollowUp(db, { tenantId: OASIS, engagement: e, link: link0, reason: "not_opened", base: "https://oasisai.work", now: later }), false, "filed once per link and reason");
    const cardId = String(card[0].id);
    const approveCard = () => db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status IN ('pending', 'failed')", args: [USERS.cc.id, new Date().toISOString(), cardId] });
    await approveCard();
    const byAdmin = await execute.executeApproval(db, { tenantId: OASIS, approvalId: cardId, approver: { userId: USERS.admin.id, email: USERS.admin.email } }, deps() as never);
    assert.equal(byAdmin.ok && (byAdmin.approval.execution_result as { reason?: string } | null)?.reason, "owner_only");
    await approveCard();
    const dry = await execute.executeApproval(db, { tenantId: OASIS, approvalId: cardId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps({ live: false }) as never);
    assert.equal(dry.ok && (dry.approval.execution_result as { outcome?: string } | null)?.outcome, "dry_run");
    assert.equal(sent.length, 1, "a dry run sends nothing");
    // The card ran once (dry run); a fresh one under a new reason goes out live.
    const fresh = await followUp.fileFollowUp(db, { tenantId: OASIS, engagement: e, link: link0, reason: "not_paid", base: "https://oasisai.work", now: later });
    assert.equal(fresh, true);
    const freshId = String((await db.execute({ sql: "SELECT id FROM approvals WHERE tenant_id = ? AND action_kind = 'follow_up_ai_audit' AND status = 'pending' LIMIT 1", args: [OASIS] })).rows[0].id);
    await db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", args: [USERS.cc.id, new Date().toISOString(), freshId] });
    const live = await execute.executeApproval(db, { tenantId: OASIS, approvalId: freshId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps() as never);
    assert.equal(live.ok && (live.approval.execution_result as { outcome?: string } | null)?.outcome, "sent", JSON.stringify(live.ok ? live.approval.execution_result : live));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].to, "owner@fixture.test");
    assert.ok(String(sent[1].body).includes(`/your-audit/${token}`), "the same link the client already has");
    assert.ok(!String(sent[1].body).includes("{{audit_link}}"));
    // The trail, and the engagement left as the next checks expect it.
    const ev = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_events WHERE engagement_id = ? AND event = 'follow_up_sent'", args: [engagementId] });
    assert.equal(Number(ev.rows[0].n), 1);
    const now2 = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.ok((await store.patchEngagement(db, { tenantId: OASIS, id: engagementId, expectedRowVersion: now2.row_version, patch: { health: "ok", health_reason: null }, event: "health_cleared", actor: cc, now: NOW() })).ok);
  });


  console.log("a revision after delivery (phase 5)");
  await check("a delivered, unpaid audit is revised: drafts open, Pay closes, and the new delivery replaces the client's link", async () => {
    // A long or two-line business name still makes a one-line subject the revision can be saved with (self-review of phase 5).
    const long = delivery.revisionEmail({ contactName: "Dana Smith", businessName: `${"Fixture ".repeat(30)}\nPlumbing` });
    assert.ok(!/[\r\n]/.test(long.subject) && long.subject.length <= 200, long.subject);
    let e = (await store.getEngagement(db, OASIS, engagementId))!;
    const oldAudit = e.current_audit_version_id!;
    const oldProposal = e.current_proposal_version_id!;
    const oldToken = token;
    const noStripe = { stripeSecret: async () => null, isDryRun: () => true, alert: async () => undefined, baseUrl: () => "https://oasisai.work" };
    const revised = await delivery.reviseAfterDelivery(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version, actor: cc, now: NOW(), payment: noStripe as never });
    assert.ok(revised.ok, !revised.ok ? revised.error : "");
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.stage, "generating");
    assert.notEqual(e.current_audit_version_id, oldAudit, "a new draft, copied");
    const draftProposal = (await versions.getProposalVersion(db, OASIS, e.current_proposal_version_id!))!;
    assert.equal(draftProposal.status, "draft");
    assert.match(draftProposal.content!.delivery_email.subject, /^Your updated AI audit for /);
    assert.ok(draftProposal.content!.delivery_email.body.includes("{{audit_link}}"));
    // The client still reads what they have, and cannot pay for it while it is being replaced.
    const stillOpen = await pub.loadPublicAudit(db, oldToken, NOW());
    assert.ok(stillOpen, "the delivered version still opens");
    assert.match(pub.payUnavailableReason(stillOpen!, NOW()) ?? "", /updating this proposal/, "the page says why it cannot be paid now");
    assert.deepEqual(await payment.createOrReuseCheckout(db, { link: stillOpen!.link, now: NOW(), deps: noStripe as never }), { ok: false, error: "not_payable" });
    // Submitted, printed and approved again, it goes out with a new link that replaces the old one.
    const sub = await delivery.submitForFinalApproval(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version, actor: cc, now: NOW() });
    assert.ok(sub.ok, !sub.ok ? `${sub.error} ${(sub.problems ?? []).join("; ")}` : "");
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    const audit2 = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    const bytes = Buffer.from("%PDF-1.4\n" + "y".repeat(400) + "\n%%EOF");
    const printed = await pdf.storePdf(db, memStorage, { tenantId: OASIS, jobInput: { audit_version_id: audit2.id, content_sha256: audit2.content_sha256 }, report: { pdfBase64: bytes.toString("base64"), sha256: hash.sha256Hex(bytes), bytes: bytes.length, pages: 6 }, now: NOW() });
    assert.ok(printed.ok);
    const card = await delivery.requestDeliveryApproval(db, { tenantId: OASIS, engagementId, now: NOW() });
    assert.ok(card.ok && card.created);
    const cardId = card.ok ? card.approvalId : "";
    await db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", args: [USERS.cc.id, new Date().toISOString(), cardId] });
    const before = sent.length;
    const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId: cardId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps() as never);
    assert.equal(r.ok && (r.approval.execution_result as { outcome?: string } | null)?.outcome, "sent");
    assert.equal(sent.length, before + 1);
    assert.match(String(sent[sent.length - 1].subject), /^Your updated AI audit for /);
    const m = /\/your-audit\/([A-Za-z0-9_-]{43})/.exec(String(sent[sent.length - 1].body));
    assert.ok(m && m[1] !== oldToken, "a new link");
    token = m![1];
    assert.equal(await pub.loadPublicAudit(db, oldToken, NOW()), null, "the old link stops");
    assert.ok(await pub.loadPublicAudit(db, token, NOW()), "the new link opens");
    assert.equal((await versions.getAuditVersion(db, OASIS, oldAudit))!.status, "superseded");
    assert.equal((await versions.getProposalVersion(db, OASIS, oldProposal))!.status, "superseded");
    assert.equal((await store.getEngagement(db, OASIS, engagementId))!.stage, "delivered");
    // A paid or undelivered audit is not revised.
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    const viaRoute = await delivery.reviseAfterDelivery(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version - 1, actor: cc, now: NOW(), payment: noStripe as never });
    assert.deepEqual(viaRoute, { ok: false, error: "conflict" });
  });

  await check("review of phase 5, finding 1: a revision waits while money moved or is moving for what the client has", async () => {
    const clearing = fakeStripe();
    const live = { stripeSecret: async () => "sk_live_fake", fetchImpl: clearing.impl, isDryRun: () => false, alert: async () => undefined, baseUrl: () => "https://oasisai.work" };
    const revise = async () => {
      const now = (await store.getEngagement(db, OASIS, engagementId))!;
      return delivery.reviseAfterDelivery(db, { tenantId: OASIS, engagementId, expectedRowVersion: now.row_version, actor: cc, now: NOW(), payment: live as never });
    };
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    const at = new Date().toISOString();
    // A Pay press still opening its Stripe page.
    await db.execute({
      sql: "INSERT INTO ai_audit_checkouts (id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, status, created_at, updated_at) VALUES ('p5-opening', ?, ?, ?, 'p5-opening-token', 'full', 100, 'cad', 'creating', ?, ?)",
      args: [OASIS, engagementId, e.current_proposal_version_id!, at, at],
    });
    assert.deepEqual(await revise(), { ok: false, error: "checkout_opening" });
    await db.execute("DELETE FROM ai_audit_checkouts WHERE id = 'p5-opening'");
    // A payment Stripe confirmed that was not placed yet.
    await db.execute({
      sql: "INSERT INTO ai_audit_payment_receipts (id, tenant_id, engagement_id, lead_id, proposal_version_id, checkout_id, provider, provider_reference, status, amount_cents, currency, installment_kind, verification_source, verified_at, created_at, updated_at) VALUES ('p5-receipt', ?, ?, ?, ?, 'p5-none', 'stripe', 'pi_p5_unplaced', 'verified', 100, 'cad', 'full', 'tick', ?, ?, ?)",
      args: [OASIS, engagementId, LEAD, e.current_proposal_version_id!, at, at, at],
    });
    assert.deepEqual(await revise(), { ok: false, error: "payment_received" });
    await db.execute("DELETE FROM ai_audit_payment_receipts WHERE id = 'p5-receipt'");
    // A checkout the client completed with a bank payment still clearing.
    const p = (await pub.loadPublicAudit(db, token, NOW()))!;
    assert.ok((await payment.createOrReuseCheckout(db, { link: p.link, now: NOW(), deps: live })).ok);
    clearing.sessions.get("cs_live_fixture1")!.complete = true;
    assert.deepEqual(await revise(), { ok: false, error: "checkout_complete" });
    assert.notEqual((await store.getEngagement(db, OASIS, engagementId))!.stage, "generating", "not revised");
    // Back as the next checks expect it: delivered, unpaid, no checkout.
    await db.execute({ sql: "DELETE FROM ai_audit_checkouts WHERE engagement_id = ?", args: [engagementId] });
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'delivered', payment_status = 'none', health = 'ok', health_reason = NULL WHERE id = ?", args: [engagementId] });
  });
  await check("review of phase 5, finding 1: a session Stripe opens while a revision lands is closed again at once", async () => {
    const race = fakeStripe();
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      // The revision's move lands while Stripe is opening the session.
      if (String(url) === "https://api.stripe.com/v1/checkout/sessions" && init?.method === "POST") await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'generating' WHERE id = ?", args: [engagementId] });
      return race.impl(url, init);
    }) as typeof fetch;
    const p = (await pub.loadPublicAudit(db, token, NOW()))!;
    const r = await payment.createOrReuseCheckout(db, { link: p.link, now: NOW(), deps: { stripeSecret: async () => "sk_live_fake", fetchImpl: impl, isDryRun: () => false, alert: async () => undefined, baseUrl: () => "https://oasisai.work" } });
    assert.deepEqual(r, { ok: false, error: "not_payable" });
    assert.equal(race.created.length, 1);
    assert.ok(race.sessions.get("cs_live_fixture1")!.expired, "closed at Stripe");
    assert.ok((await payment.listCheckouts(db, OASIS, engagementId)).every((c) => c.status === "expired"));
    // The tick's sweep finds any such session by itself too.
    await db.execute({ sql: "UPDATE ai_audit_checkouts SET status = 'open' WHERE engagement_id = ?", args: [engagementId] });
    assert.deepEqual(await payment.closedEngagementsWithOpenCheckouts(db, OASIS), [engagementId]);
    await db.execute({ sql: "DELETE FROM ai_audit_checkouts WHERE engagement_id = ?", args: [engagementId] });
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'delivered' WHERE id = ?", args: [engagementId] });
  });
  await check("review of phase 5, finding 1: a payment for a replaced proposal is kept and flagged, never settled onto the new delivery", async () => {
    const old = String((await db.execute({ sql: "SELECT id FROM ai_audit_proposal_versions WHERE engagement_id = ? AND status = 'superseded' LIMIT 1", args: [engagementId] })).rows[0].id);
    const alerts: string[] = [];
    const out = await payment.settlePayment(db, {
      tenantId: OASIS,
      engagementId,
      checkout: { id: "p5-old-checkout", proposal_version_id: old, installment_kind: "full" },
      receiptId: "p5-old-receipt",
      reference: "pi_p5_old",
      amountCents: 100,
      currency: "cad",
      trigger: "tick",
      now: NOW(),
      deps: { alert: async (a: { alertType: string }) => void alerts.push(a.alertType) } as never,
    });
    assert.equal(out, "unplaced");
    const after = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(after.stage, "delivered", "not settled onto the new delivery");
    assert.deepEqual([after.health, after.payment_status], ["failed", "paid"]);
    assert.deepEqual(alerts, ["ai_audit_payment_unplaced"]);
    assert.ok((await store.patchEngagement(db, { tenantId: OASIS, id: engagementId, expectedRowVersion: after.row_version, patch: { health: "ok", health_reason: null, payment_status: "none" }, event: "health_cleared", actor: cc, now: NOW() })).ok);
  });
  await check("review of phase 5, finding 2: a resend that fails gives the client back the link they had", async () => {
    const live = (await pub.loadPublicAudit(db, token, NOW()))!;
    const fresh = await link.createShareLink(db, {
      tenantId: OASIS,
      engagementId,
      auditVersionId: live.link.audit_version_id,
      proposalVersionId: live.link.proposal_version_id,
      approvalId: "p5-resend",
      token: "p5-resend-token".padEnd(43, "x"),
      now: new Date(Date.now() + 1_000),
    });
    assert.equal(await pub.loadPublicAudit(db, token, NOW()), null, "one live link at a time");
    assert.ok(await link.revokeShareLinkRestoringReplaced(db, OASIS, fresh, "send_failed", new Date()));
    assert.ok(await pub.loadPublicAudit(db, token, NOW()), "the earlier link works again");
    await db.execute({ sql: "DELETE FROM ai_audit_share_links WHERE id = ?", args: [fresh.id] });
  });
  await check("review of phase 5, findings 3 to 5: a follow-up goes only where the audit went, only while its reason holds; a stale card is withdrawn", async () => {
    const followUp = await import("../lib/ai-audit/follow-up");
    let e = (await store.getEngagement(db, OASIS, engagementId))!;
    const current = (await link.getShareLink(db, OASIS, e.share_link_id!))!;
    // An admin changed the contact field since the audit went out, and the name is long and on two lines.
    assert.ok((await store.patchEngagement(db, { tenantId: OASIS, id: engagementId, expectedRowVersion: e.row_version, patch: { contact_email: "someone-else@fixture.test" }, event: "details_saved", actor: cc, now: NOW() })).ok);
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    const longName = { ...e, business_name: `${"Fixture ".repeat(30)}\nPlumbing` };
    assert.equal(await followUp.fileFollowUp(db, { tenantId: OASIS, engagement: longName, link: current, reason: "not_opened", base: "https://oasisai.work", now: NOW() }), true, "a long name never refuses the card");
    const card = (await db.execute({ sql: "SELECT id, payload_json FROM approvals WHERE tenant_id = ? AND action_kind = 'follow_up_ai_audit' AND status = 'pending' AND json_extract(payload_json, '$.share_link_id') = ? LIMIT 1", args: [OASIS, current.id] })).rows[0];
    assert.equal(JSON.parse(String(card.payload_json)).to, "owner@fixture.test", "the address the audit went to");
    // The client opened it meanwhile: a "not opened" note is the wrong email, and nothing goes.
    await db.execute({ sql: "UPDATE ai_audit_share_links SET first_viewed_at = ? WHERE id = ?", args: [new Date().toISOString(), current.id] });
    await db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", args: [USERS.cc.id, new Date().toISOString(), String(card.id)] });
    const before = sent.length;
    const r = await execute.executeApproval(db, { tenantId: OASIS, approvalId: String(card.id), approver: { userId: USERS.cc.id, email: USERS.cc.email } }, deps() as never);
    assert.equal(r.ok && (r.approval.execution_result as { reason?: string } | null)?.reason, "reason_gone");
    assert.equal(sent.length, before);
    // A card that stops fitting while it waits (here the client paid) is withdrawn by the tick's sweep.
    assert.equal(await followUp.fileFollowUp(db, { tenantId: OASIS, engagement: e, link: { ...current, first_viewed_at: new Date().toISOString() }, reason: "not_paid", base: "https://oasisai.work", now: NOW() }), true);
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.ok((await store.patchEngagement(db, { tenantId: OASIS, id: engagementId, expectedRowVersion: e.row_version, patch: { payment_status: "paid" }, event: "test_paid", actor: cc, now: NOW() })).ok);
    assert.equal(await followUp.withdrawStaleFollowUps(db, OASIS, NOW()), 1);
    // A link that no longer opens gets no card at all.
    assert.equal(await followUp.fileFollowUp(db, { tenantId: OASIS, engagement: e, link: { ...current, revoked_at: new Date().toISOString() }, reason: "not_opened", base: "https://oasisai.work", now: NOW() }), false);
    // Back as the next checks expect it.
    e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.ok((await store.patchEngagement(db, { tenantId: OASIS, id: engagementId, expectedRowVersion: e.row_version, patch: { payment_status: "none", contact_email: "owner@fixture.test" }, event: "test_restored", actor: cc, now: NOW() })).ok);
    await db.execute({ sql: "UPDATE ai_audit_share_links SET first_viewed_at = NULL WHERE id = ?", args: [current.id] });
  });
  await check("review of phase 5: a revision whose drafts cannot be made goes back to what the client has", async () => {
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    const noStripe = { stripeSecret: async () => null, isDryRun: () => true, alert: async () => undefined, baseUrl: () => "https://oasisai.work" };
    await db.execute("CREATE TRIGGER p5_no_draft BEFORE INSERT ON ai_audit_versions BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    const r = await delivery.reviseAfterDelivery(db, { tenantId: OASIS, engagementId, expectedRowVersion: e.row_version, actor: cc, now: NOW(), payment: noStripe as never });
    await db.execute("DROP TRIGGER p5_no_draft");
    assert.ok(!r.ok);
    const back = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.deepEqual(
      [back.stage, back.current_audit_version_id, back.current_proposal_version_id, back.delivery_approval_id, back.share_link_id, back.health],
      [e.stage, e.current_audit_version_id, e.current_proposal_version_id, e.delivery_approval_id, e.share_link_id, e.health],
    );
    assert.ok(await pub.loadPublicAudit(db, token, NOW()), "the client's link still opens");
    // While the client has it, nothing saves a draft over the delivered versions (re-review of phase 5).
    const now2 = (await store.getEngagement(db, OASIS, engagementId))!;
    const delivered = (await versions.getProposalVersion(db, OASIS, now2.current_proposal_version_id!))!;
    assert.deepEqual(
      await versions.saveProposalDraft(db, { tenantId: OASIS, engagementId, content: delivered.content!, actor: cc, now: NOW(), expectedRowVersion: now2.row_version, tax: null }),
      { ok: false, error: "not_editable" },
    );
    const deliveredAudit = (await versions.getAuditVersion(db, OASIS, now2.current_audit_version_id!))!;
    assert.deepEqual(
      await versions.saveAuditDraft(db, { tenantId: OASIS, engagementId, doc: deliveredAudit.doc!, actor: cc, now: NOW(), expectedRowVersion: now2.row_version }),
      { ok: false, error: "not_editable" },
    );
  });

  console.log("the client's link");
  await check("the link opens the delivered audit; a bad, revoked or expired link opens nothing", async () => {
    const p = await pub.loadPublicAudit(db, token, NOW());
    assert.ok(p);
    assert.equal(p!.audit.doc.business.name, "[TEST] OASIS Audit Fixture Co");
    assert.equal(await pub.loadPublicAudit(db, "x".repeat(43), NOW()), null);
    assert.equal(await pub.loadPublicAudit(db, `${token}a`, NOW()), null);
    assert.equal(await pub.loadPublicAudit(db, token, new Date(Date.now() + 40 * 86_400_000)), null, "expired after 30 days");
  });
  await check("the first counted view is recorded once", async () => {
    const p = (await pub.loadPublicAudit(db, token, NOW()))!;
    assert.equal(await link.recordLinkView(db, p.link, NOW()), true);
    const p2 = (await pub.loadPublicAudit(db, token, NOW()))!;
    assert.equal(await link.recordLinkView(db, p2.link, NOW()), false);
  });

  await check("route level: the client's own page may press Pay, another site may not; in dry run no session is made", async () => {
    const { NextRequest } = await import("next/server");
    const payRoute = await import("../app/api/your-audit/[token]/pay/route");
    const params = { params: Promise.resolve({ token }) };
    const post = (headers: Record<string, string>) =>
      new NextRequest(`https://oasisai.work/api/your-audit/${token}/pay`, { method: "POST", headers: { host: "oasisai.work", ...headers } });
    const evil = await payRoute.POST(post({ origin: "https://evil.example" }), params);
    assert.equal(evil.status, 403);
    // What Chromium sends from a no-referrer page (seen 2026-10-25): Origin null, Sec-Fetch-Site same-origin.
    const own = await payRoute.POST(post({ origin: "null", "sec-fetch-site": "same-origin" }), params);
    assert.equal(own.status, 303);
    assert.match(own.headers.get("location") ?? "", /\/your-audit\/[A-Za-z0-9_-]{43}\?pay=unavailable$/, "dry run: back to the page with a plain message");
    const fromPage = await payRoute.POST(post({ origin: "https://oasisai.work" }), params);
    assert.equal(fromPage.status, 303);
    assert.equal((await payment.listCheckouts(db, OASIS, engagementId)).length, 0, "no session was made");
  });

  console.log("payment");
  const stripe = fakeStripe();
  const payDeps = { stripeSecret: async () => "sk_live_fake", fetchImpl: stripe.impl, isDryRun: () => false, alert: async () => undefined, baseUrl: () => "https://oasisai.work" };
  await check("Pay opens one Stripe session for the approved amount and reuses it; pressing Pay is not paying", async () => {
    const p = (await pub.loadPublicAudit(db, token, NOW()))!;
    const first = await payment.createOrReuseCheckout(db, { link: p.link, now: NOW(), deps: payDeps });
    assert.ok(first.ok && !first.reused);
    const second = await payment.createOrReuseCheckout(db, { link: p.link, now: NOW(), deps: payDeps });
    assert.ok(second.ok && second.reused);
    assert.equal(stripe.created.length, 1, "one payment request");
    const body = stripe.created[0].body;
    assert.equal(body.get("line_items[0][price_data][unit_amount]"), "100");
    assert.equal(body.get("metadata[oasis_checkout]"), "ai_audit_v1");
    assert.match(stripe.created[0].headers["Idempotency-Key"], /^oasis-ai-audit-/);
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.stage, "payment_pending");
    assert.equal(e.payment_status, "pending");
  });
  await check("the payment switch stops even an open live session being handed out (Codex review of PR #732)", async () => {
    const p = (await pub.loadPublicAudit(db, token, NOW()))!;
    assert.equal((await payment.listCheckouts(db, OASIS, engagementId)).filter((c) => c.status === "open").length, 1, "a live session is open");
    const r = await payment.createOrReuseCheckout(db, { link: p.link, now: NOW(), deps: { ...payDeps, isDryRun: () => true } });
    assert.ok(!r.ok && r.error === "dry_run", "switched off: no URL, not even the open one");
  });
  await check("in dry run the Pay button makes no payment request at all", async () => {
    const p = (await pub.loadPublicAudit(db, token, NOW()))!;
    const before = stripe.created.length;
    await db.execute({ sql: "UPDATE ai_audit_checkouts SET status = 'expired' WHERE tenant_id = ?", args: [OASIS] });
    const r = await payment.createOrReuseCheckout(db, { link: p.link, now: NOW(), deps: { ...payDeps, isDryRun: () => true } });
    assert.ok(!r.ok && r.error === "dry_run");
    assert.equal(stripe.created.length, before);
    await db.execute({ sql: "UPDATE ai_audit_checkouts SET status = 'open' WHERE tenant_id = ?", args: [OASIS] });
  });
  let checkoutId = "";
  await check("an unpaid session confirms nothing; Stripe's paid session does, exactly once", async () => {
    const c = (await payment.listCheckouts(db, OASIS, engagementId))[0];
    checkoutId = c.id;
    const unpaid = await payment.verifyCheckout(db, { tenantId: OASIS, checkoutId, now: NOW(), trigger: "tick", deps: payDeps });
    assert.equal(unpaid.status, "unpaid");
    assert.equal((await store.getEngagement(db, OASIS, engagementId))!.payment_status, "pending");
    stripe.sessions.get(c.stripe_session_id!)!.paid = true;
    const paid = await payment.verifyCheckout(db, { tenantId: OASIS, checkoutId, now: NOW(), trigger: "webhook", deps: payDeps });
    assert.ok(paid.status === "paid" && !paid.duplicate);
    const dup = await payment.verifyCheckout(db, { tenantId: OASIS, checkoutId, now: NOW(), trigger: "owner", deps: payDeps });
    assert.ok(dup.status === "paid" && dup.duplicate);
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.stage, "payment_confirmed");
    assert.equal(e.payment_status, "paid");
    assert.equal(await leadStage(db, LEAD), "won");
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_payment_receipts", args: [] })).rows[0].n), 1);
  });

  console.log("onboarding");
  await check("onboarding creates one client, one project, its checklist and one welcome-email approval, however often it runs", async () => {
    const alerts: unknown[] = [];
    const od = { alert: async (a: unknown) => void alerts.push(a), baseUrl: () => "https://oasisai.work" };
    const r1 = await onboarding.runOnboarding(db, { tenantId: OASIS, engagementId, now: NOW(), deps: od });
    assert.ok(r1.ok, !r1.ok ? r1.error : "");
    const r2 = await onboarding.runOnboarding(db, { tenantId: OASIS, engagementId, now: NOW(), deps: od });
    assert.ok(r2.ok);
    const count = async (sql: string) => Number((await db.execute({ sql, args: [OASIS] })).rows[0].n);
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND primary_email = 'owner@fixture.test'"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM delivery_projects WHERE tenant_id = ? AND lead_id IS NOT NULL"), 1);
    const tasks = await count("SELECT COUNT(*) AS n FROM delivery_tasks WHERE tenant_id = ?");
    assert.equal(tasks, onboarding.STANDARD_CHECKLIST.length + 1, "the standard steps plus the fixture item's requirement");
    assert.equal(await count("SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND action_kind = 'send_email' AND idempotency_key LIKE 'ai-audit-welcome:%'"), 1);
    assert.equal(alerts.length, 1, "one alert to CC");
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.stage, "onboarding");
    assert.equal(await leadStage(db, LEAD), "onboarding");
    const welcome = await db.execute({ sql: "SELECT payload_json FROM approvals WHERE tenant_id = ? AND action_kind = 'send_email'", args: [OASIS] });
    assert.match(String(welcome.rows[0].payload_json), /never send passwords/i);
  });
  await check("the checklist done makes an Active Client and moves the lead into the build", async () => {
    assert.equal(await onboarding.completeOnboardingIfDone(db, { tenantId: OASIS, engagementId, now: NOW() }), false);
    await db.execute({ sql: "UPDATE delivery_tasks SET status = 'done' WHERE tenant_id = ?", args: [OASIS] });
    assert.equal(await onboarding.completeOnboardingIfDone(db, { tenantId: OASIS, engagementId, now: NOW() }), true);
    const done = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(done.stage, "active_client");
    assert.equal(done.closed_reason, "active_client");
    assert.ok(done.closed_at, "the audit cycle is closed");
    assert.equal(await ownership.aiAuditOwnsLead(OASIS, LEAD), false, "website sales may work the lead again");
    assert.equal(await leadStage(db, LEAD), "in_build");
  });
  await check("a later refund is caught by the re-check, flagged, and deletes nothing", async () => {
    const c = (await payment.listCheckouts(db, OASIS, engagementId))[0];
    stripe.sessions.get(c.stripe_session_id!)!.refunded = true;
    await db.execute({ sql: "UPDATE ai_audit_payment_receipts SET last_reconciled_at = '2000-01-01T00:00:00Z' WHERE tenant_id = ?", args: [OASIS] });
    // The engagement's write fails once (Codex review of PR #732): the receipt must stay verified and be checked again.
    await db.execute("CREATE TRIGGER fail_refund_event BEFORE INSERT ON ai_audit_events WHEN NEW.event = 'payment_refunded' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    const failed = await payment.reconcileReceipts(db, OASIS, NOW(), payDeps).catch((err: unknown) => err);
    await db.execute("DROP TRIGGER fail_refund_event");
    assert.ok(!(failed instanceof Error) || /injected_failure/.test(failed.message), String(failed));
    assert.equal(String((await db.execute({ sql: "SELECT status FROM ai_audit_payment_receipts WHERE tenant_id = ?", args: [OASIS] })).rows[0].status), "verified", "not lost");
    assert.equal((await store.getEngagement(db, OASIS, engagementId))!.payment_status, "paid");
    await db.execute({ sql: "UPDATE ai_audit_payment_receipts SET last_reconciled_at = '2000-01-01T00:00:00Z' WHERE tenant_id = ?", args: [OASIS] });
    const alerts: unknown[] = [];
    const r = await payment.reconcileReceipts(db, OASIS, NOW(), { ...payDeps, alert: async (a) => void alerts.push(a) });
    assert.equal(r.changed, 1);
    const e = (await store.getEngagement(db, OASIS, engagementId))!;
    assert.equal(e.payment_status, "refunded");
    assert.equal(e.health, "attention");
    assert.equal(alerts.length, 1);
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM delivery_projects WHERE tenant_id = ? AND lead_id IS NOT NULL", args: [OASIS] })).rows[0].n), 1, "the project is kept");
  });

  console.log("guards");
  await check("a mismatched payment is refused and flagged, not counted", async () => {
    const real = (await store.getOpenEngagementForLead(db, OASIS, LEAD_B))!;
    await db.execute({
      sql: `INSERT INTO ai_audit_checkouts (id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, stripe_session_id, status, created_at, updated_at)
            VALUES ('co-mismatch', ?, ?, 'pv-x', '33333333-3333-4333-8333-333333333333', 'full', 5000, 'CAD', 'cs_live_mismatch', 'open', ?, ?)`,
      args: [OASIS, real.id, new Date().toISOString(), new Date().toISOString()],
    });
    stripe.sessions.set("cs_live_mismatch", { id: "cs_live_mismatch", amount: 4000, currency: "cad", metadata: { oasis_tenant_id: OASIS, oasis_lead_id: LEAD_B, oasis_payment_token: "33333333-3333-4333-8333-333333333333", oasis_payment_plan_id: "pv-x" }, client_reference_id: LEAD_B, paid: true, refunded: false, disputed: false });
    const v = await payment.verifyCheckout(db, { tenantId: OASIS, checkoutId: "co-mismatch", now: NOW(), trigger: "tick", deps: payDeps });
    assert.ok(v.status === "problem" && v.code === "payment_does_not_match_proposal");
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_payment_receipts WHERE engagement_id = ?", args: [real.id] })).rows[0].n), 0);
    assert.equal((await store.getEngagement(db, OASIS, real.id))!.health, "attention");
  });
  await check("while an audit is open on a lead, website sales may not issue a second price", async () => {
    assert.equal(await ownership.aiAuditOwnsLead(OASIS, LEAD_B), true);
    const real = (await store.getOpenEngagementForLead(db, OASIS, LEAD_B))!;
    await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: real.id, to: "cancelled", actor: cc, now: NOW() });
    assert.equal(await ownership.aiAuditOwnsLead(OASIS, LEAD_B), false);
  });
  const closedId = (await store.listEngagementsForLead(db, OASIS, LEAD_B))[0].id;
  await check("a payment that lands on a cancelled engagement is kept, flagged failed and alerted, never onboarded", async () => {
    const tokenLate = "44444444-4444-4444-8444-444444444444";
    await db.execute({
      sql: `INSERT INTO ai_audit_checkouts (id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, stripe_session_id, status, created_at, updated_at)
            VALUES ('co-late', ?, ?, 'pv-late', ?, 'full', 7000, 'CAD', 'cs_live_late', 'open', ?, ?)`,
      args: [OASIS, closedId, tokenLate, new Date().toISOString(), new Date().toISOString()],
    });
    stripe.sessions.set("cs_live_late", { id: "cs_live_late", amount: 7000, currency: "cad", metadata: { oasis_tenant_id: OASIS, oasis_lead_id: LEAD_B, oasis_payment_token: tokenLate, oasis_payment_plan_id: "pv-late" }, client_reference_id: LEAD_B, paid: true, refunded: false, disputed: false });
    const alerts: Array<Record<string, unknown>> = [];
    const v = await payment.verifyCheckout(db, { tenantId: OASIS, checkoutId: "co-late", now: NOW(), trigger: "webhook", deps: { ...payDeps, alert: async (a) => void alerts.push(a as Record<string, unknown>) } });
    assert.equal(v.status, "paid");
    const e = (await store.getEngagement(db, OASIS, closedId))!;
    assert.equal(e.stage, "cancelled");
    assert.equal(e.health, "failed");
    assert.equal(e.payment_status, "paid");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].alertType, "ai_audit_payment_unplaced");
    assert.equal(await payment.settleVerifiedReceipts(db, OASIS, NOW(), payDeps), 0, "already flagged: the tick does not alert again");
    assert.equal(e.delivery_project_id, null, "nothing was onboarded");
  });
  await check("a declined or cancelled engagement's open payment links are expired at Stripe", async () => {
    await db.execute({
      sql: `INSERT INTO ai_audit_checkouts (id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, stripe_session_id, status, created_at, updated_at)
            VALUES ('co-open2', ?, ?, 'pv-open2', '55555555-5555-4555-8555-555555555555', 'full', 7000, 'CAD', 'cs_live_open2', 'open', ?, ?)`,
      args: [OASIS, closedId, new Date().toISOString(), new Date().toISOString()],
    });
    stripe.sessions.set("cs_live_open2", { id: "cs_live_open2", amount: 7000, currency: "cad", metadata: {}, client_reference_id: LEAD_B, paid: false, refunded: false, disputed: false });
    assert.ok((await payment.closedEngagementsWithOpenCheckouts(db, OASIS)).includes(closedId));
    const r = await payment.expireOpenCheckouts(db, OASIS, closedId, NOW(), payDeps);
    assert.ok(r.expired >= 1);
    assert.equal(stripe.sessions.get("cs_live_open2")!.expired, true, "expired at Stripe");
    const row = await db.execute({ sql: "SELECT status FROM ai_audit_checkouts WHERE id = 'co-open2'", args: [] });
    assert.equal(String(row.rows[0].status), "expired");
  });
  await check("a session marked expired here early is still polled until Stripe's own expiry has passed", async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const long = new Date(Date.now() - 3 * 3_600_000).toISOString();
    for (const [id, exp] of [["co-x-recent", soon], ["co-x-old", long]] as const) {
      await db.execute({
        sql: `INSERT INTO ai_audit_checkouts (id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, stripe_session_id, status, created_at, updated_at, expires_at)
              VALUES (?, ?, ?, ?, ?, 'full', 7000, 'CAD', ?, 'expired', ?, ?, ?)`,
        args: [id, OASIS, closedId, `pv-${id}`, `66666666-6666-4666-8666-${id === "co-x-old" ? "000000000001" : "000000000002"}`, `cs_live_${id.replace(/-/g, "_")}`, new Date().toISOString(), new Date().toISOString(), exp],
      });
    }
    const due = (await payment.dueOpenCheckouts(db, OASIS, new Date(), 50)).map((c) => c.id);
    assert.ok(due.includes("co-x-recent"));
    assert.ok(!due.includes("co-x-old"));
    await db.execute("DELETE FROM ai_audit_checkouts WHERE id IN ('co-x-recent', 'co-x-old')");
  });
  await check("three failed prints stop the queue and ask CC; Retry clears them", async () => {
    for (let i = 0; i < 3; i++) {
      await db.execute({
        sql: "INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, dedupe_key, error_code, error_message, created_at, updated_at) VALUES (?, ?, 'ai_audit_pdf', 'runner', 'failed', '{}', 'h', 'ai_audit_pdf:v-print', 'render_failed', 'chromium crashed', ?, ?)",
        args: [`job-print-${i}`, OASIS, new Date(Date.now() + i).toISOString(), new Date(Date.now() + i).toISOString()],
      });
    }
    const f = await pdf.pdfFailures(db, OASIS, "v-print");
    assert.equal(f.count, 3);
    assert.match(f.lastError ?? "", /render_failed: chromium crashed/);
    assert.ok(f.count >= pdf.PDF_MAX_FAILURES);
    assert.equal(await pdf.clearPdfFailures(db, OASIS, "v-print"), 3);
    assert.equal((await pdf.pdfFailures(db, OASIS, "v-print")).count, 0);
  });
  await check("payment status comes from every receipt: refunding the duplicate of two leaves the proposal paid", async () => {
    assert.equal(payment.aggregatePaymentStatus(["verified", "refunded"]), "paid");
    assert.equal(payment.aggregatePaymentStatus(["verified", "verified"]), "overpaid_review");
    assert.equal(payment.aggregatePaymentStatus(["refunded"]), "refunded");
    assert.equal(payment.aggregatePaymentStatus(["refunded", "disputed"]), "disputed");
    assert.equal(payment.aggregatePaymentStatus(["partially_refunded"]), "partially_refunded");
  });
  await check("onboarding an existing customer keeps the client workspace it already has (Codex review of PR #732)", async () => {
    // A customer already linked to this lead, with its own client workspace.
    await db.execute({ sql: "UPDATE customers SET source_lead_id = ? WHERE id = 'customer-oasis-client-a'", args: [LEAD_D] });
    const opened = await store.openEngagement(db, { tenantId: OASIS, leadId: LEAD_D, actor: cc, now: NOW(), isFixture: true });
    assert.ok(opened.ok);
    const id = opened.ok ? opened.engagement.id : "";
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'payment_confirmed', payment_status = 'paid' WHERE id = ?", args: [id] });
    const r = await onboarding.runOnboarding(db, { tenantId: OASIS, engagementId: id, now: NOW(), deps: { alert: async () => undefined, baseUrl: () => "https://oasisai.work" } });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const project = (await db.execute({ sql: "SELECT client_tenant_id, customer_id FROM delivery_projects WHERE lead_id = ?", args: [LEAD_D] })).rows[0];
    assert.equal(String(project.customer_id), "customer-oasis-client-a");
    assert.equal(String(project.client_tenant_id), CLIENT_A);
  });
  await check("after an uncertain send CC can record that it went: delivered with the link that email carries, nothing sent", async () => {
    const opened = await store.openEngagement(db, { tenantId: OASIS, leadId: LEAD_C, actor: cc, now: NOW(), isFixture: true });
    assert.ok(opened.ok);
    const id = opened.ok ? opened.engagement.id : "";
    const at = new Date().toISOString();
    await db.batch([
      { sql: "INSERT INTO ai_audit_versions (id, tenant_id, engagement_id, version_no, status, content, content_sha256, created_at, updated_at) VALUES ('ver-c', ?, ?, 1, 'awaiting_approval', '{}', ?, ?, ?)", args: [OASIS, id, "a".repeat(64), at, at] },
      { sql: "INSERT INTO ai_audit_proposal_versions (id, tenant_id, engagement_id, version_no, status, currency, content, content_sha256, created_at, updated_at) VALUES ('prop-c', ?, ?, 1, 'awaiting_approval', 'CAD', '{}', ?, ?, ?)", args: [OASIS, id, "b".repeat(64), at, at] },
    ]);
    const payload = { engagement_id: id, lead_id: LEAD_C, business_name: "C Co", audit_version_id: "ver-c", audit_sha256: "a".repeat(64), proposal_version_id: "prop-c", proposal_sha256: "b".repeat(64), pdf_sha256: "c".repeat(64), to: "third@fixture.test", subject: "Your audit", body: "Hi\n\n{{audit_link}}", currency: "CAD", total_cents: 100, due_now_cents: 100 };
    const made = await approvalsStore.createApproval(db, { tenantId: OASIS, departmentKey: null, requestedBy: { type: "routine", id: "ai-audit" }, actionKind: "deliver_ai_audit", title: "C", payload, riskLevel: "spend", idempotencyKey: "uncertain-c" }, NOW());
    assert.ok(made.ok);
    const aId = made.ok ? made.approval.id : "";
    await db.execute({ sql: "UPDATE approvals SET status = 'failed', execution_result = ? WHERE id = ?", args: [JSON.stringify({ outcome: "failed", reason: "delivery_unknown", message: "maybe", provider: "oasis_shared_gmail" }), aId] });
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'final_review', delivery_approval_id = ?, current_audit_version_id = 'ver-c', current_proposal_version_id = 'prop-c' WHERE id = ?", args: [aId, id] });
    await link.createShareLink(db, { tenantId: OASIS, engagementId: id, auditVersionId: "ver-c", proposalVersionId: "prop-c", approvalId: aId, token: link.mintLinkToken(process.env.AI_AUDIT_LINK_SECRET!, "uncertain-c"), now: NOW() });
    const before = sent.length;
    const ok = await delivery.confirmUncertainDelivery(db, { tenantId: OASIS, engagementId: id, actor: cc });
    assert.deepEqual(ok, { ok: true });
    const e = (await store.getEngagement(db, OASIS, id))!;
    assert.equal(e.stage, "delivered");
    assert.ok(e.share_link_id);
    assert.equal(sent.length, before, "nothing was sent");
    assert.deepEqual(await delivery.confirmUncertainDelivery(db, { tenantId: OASIS, engagementId: id, actor: cc }), { ok: false, error: "nothing_uncertain" }, "only once");
  });
  await check("a submitted audit leaves final review only by Reopen, decline or cancel (Codex review of PR #732)", async () => {
    const rules = await import("../lib/ai-audit/rules");
    assert.equal(rules.mayMoveStage("final_review", "transcript_review"), false);
    assert.equal(rules.mayMoveStage("final_review", "generating"), true);
  });
  await check("the tick runs every step without contacting anyone and reports cleanly", async () => {
    const before = sent.length;
    const r = await tick.runAiAuditTick(db, { budgetMs: 30_000, deps: { payment: { ...payDeps, alert: async () => undefined }, onboarding: { alert: async () => undefined, baseUrl: () => "https://oasisai.work" } } });
    assert.deepEqual(r.errors, []);
    // The delivery, and the one follow-up CC approved: the tick itself sends nothing.
    assert.equal(sent.length, before, "the tick sends no email");
    assert.equal(sent.length, 3, "three emails ever sent: the delivery, the approved follow-up and the revised delivery");
  });

  finish("ai-audit-flow");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
