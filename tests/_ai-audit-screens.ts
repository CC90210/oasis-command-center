/**
 * tests/_ai-audit-screens.ts — every Free AI Audit screen, drawn with the data
 * its page builds, for every engagement a suite leaves behind (CC, 2026-10-27:
 * "ensure that it's 100% turnkey and the actual fixes are in the front end").
 *
 * Each audit suite calls checkAuditScreens(db, tenantId, ownerUserId) at its
 * end, so every stage an engagement reaches in the suites (a new lead, a call,
 * Gate 1, research, the drafts, final review, delivery, payment, onboarding,
 * declined) is drawn through the real components:
 *   - the engagement workspace for the owner and for an admin who is not the
 *     owner, opened on the overview (the call, profile, research, audit and
 *     proposal tabs stay mounted, so they draw too), and again on its Delivery
 *     and History tabs, which draw only while open;
 *   - the live-call screen;
 *   - the client's own audit page, wherever an audit and its proposal exist;
 *   - every Needs-you card the audit filed (Gate 1, Gate 2, follow-ups), built
 *     by the Feed's own builder for the owner, full and compact;
 *   - the catalogue, the settings form and the setup checklist (nothing set up,
 *     and everything set up);
 *   - the proposal editor with a line waiting for a price whose suggested item
 *     is now confirmed, and a tax rule set after the draft was saved.
 * The props go through JSON, as the pages send them.
 *
 * What it holds a screen to:
 *   - it draws at all (a throw is a broken page for CC);
 *   - the workspace always says where the engagement stands and what comes
 *     next (its stage and its "Next:" step), so no stage is a dead end;
 *   - no "undefined", "NaN", "Invalid Date" or "[object Object]" reaches the text;
 *   - an approval card reads as words: no payload keys, hashes or the link
 *     placeholder, and a way to the engagement it is about;
 *   - the client's page carries all nine sections.
 * The drawing happens in tests/ai-audit-ui.render.ts (React without the
 * react-server conditions these suites run under).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { Client } from "@libsql/client";

/** Text as a person reads it: no tags, the usual entities decoded, spaces collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const BROKEN_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/;

/** What a card would show if it fell back to dumping its payload. */
const RAW_CARD_TEXT = /sha256|\{\{audit_link\}\}|\btotal cents\b|\bdue now cents\b|\bengagement id\b|\blead id\b|\bprofile version id\b|\bengine (mac_claude|cloud_workspace|none)\b|\["/;

type Scenario = { id: string; screen: string; props: Record<string, unknown> };
type Expect = { stage?: string; next?: string; has?: string[]; hasNot?: RegExp[]; html?: string[] };

/** Draws every screen for every engagement of the tenant and checks each. Answers how many screens were drawn. */
export async function checkAuditScreens(db: Client, tenantId: string, ownerUserId: string): Promise<number> {
  const view = await import("../lib/ai-audit/view");
  const store = await import("../lib/ai-audit/store");
  const catalogue = await import("../lib/ai-audit/catalogue-store");
  const versions = await import("../lib/ai-audit/versions");
  const proposal = await import("../lib/ai-audit/proposal");
  const doc = await import("../lib/ai-audit/doc");
  const setup = await import("../lib/ai-audit/setup");
  const approvalStore = await import("../lib/os/approvals/store");
  const approvalView = await import("../lib/os/approvals/view");
  const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const scenarios: Scenario[] = [];
  const expect = new Map<string, Expect>();
  const ids = (await db.execute({ sql: "SELECT id FROM ai_audit_engagements WHERE tenant_id = ? ORDER BY created_at", args: [tenantId] })).rows.map((r) => String(r.id));
  assert.ok(ids.length > 0, "the suite left no engagement to draw");
  let first: Awaited<ReturnType<typeof view.engagementView>> = null;
  for (const id of ids) {
    const v = await view.engagementView(db, tenantId, id, new Date());
    assert.ok(v, `engagement ${id} has no view`);
    first ??= v;
    const e = await store.getEngagement(db, tenantId, id);
    assert.ok(e);
    for (const isOwner of [true, false]) {
      const key = `workspace:${id}:${isOwner ? "owner" : "admin"}`;
      scenarios.push({ id: key, screen: "workspace", props: { view: json(v), isOwner } });
      expect.set(key, { stage: v.row.stage_label, next: v.row.next_action });
      scenarios.push({ id: `${key}:delivery`, screen: "workspace", props: { view: json(v), isOwner, initialTab: "delivery" } });
      expect.set(`${key}:delivery`, { has: ["Final approval and PDF", "Payment and onboarding"] });
    }
    scenarios.push({ id: `workspace:${id}:history`, screen: "workspace", props: { view: json(v), isOwner: true, initialTab: "history" } });
    scenarios.push({ id: `call:${id}`, screen: "call", props: json(await view.liveCallProps(db, tenantId, e)) });
    // The client's own page, drawn as /your-audit/<token> draws it, wherever an audit and its proposal exist.
    const audit = e.current_audit_version_id ? await versions.getAuditVersion(db, tenantId, e.current_audit_version_id) : null;
    const offer = e.current_proposal_version_id ? await versions.getProposalVersion(db, tenantId, e.current_proposal_version_id) : null;
    if (audit?.doc && offer?.content) {
      scenarios.push({
        id: `document:${id}`,
        screen: "document",
        props: json({ doc: audit.doc, proposal: offer.content, totals: proposal.proposalTotals(offer.content), mode: "web", payAction: "/api/your-audit/x/pay", payUnavailable: null, pdfHref: null, notice: null }),
      });
      expect.set(`document:${id}`, { has: [...doc.SECTION_TITLES] });
    }
  }
  // The retirement state must read as an intentional deferral, while keeping
  // the deterministic research and document pipeline visible as live work.
  {
    const deferred = json(first as NonNullable<typeof first>);
    deferred.modelSearchEnabled = false;
    deferred.settings = { ...deferred.settings, engine: "none" };
    deferred.engagement = { ...deferred.engagement, stage: "generating" };
    deferred.research ??= { latest: null, step: null, assumptions: {}, estimates: [], writing: null };
    deferred.research.step = { id: "deferred-search-step", status: "running", phase: "search", error: null, created_at: new Date().toISOString() };
    scenarios.push({ id: "workspace:model-search-deferred", screen: "workspace", props: { view: deferred, isOwner: true, initialTab: "research" } });
    expect.set("workspace:model-search-deferred", {
      has: ["Running: Checking authorized public sources.", "Model and web search are deferred", "Deterministic website checks", "audit and proposal drafting", "PDF printing continue"],
      hasNot: [/Handing the web search to CC's Mac/i, /Waiting for the web search on CC's Mac/i],
    });
  }
  {
    const cloud = json(first as NonNullable<typeof first>);
    cloud.modelSearchEnabled = true;
    cloud.settings = { ...cloud.settings, engine: "cloud_workspace" };
    cloud.authorization = null;
    cloud.engagement = { ...cloud.engagement, stage: "generating" };
    cloud.research ??= { latest: null, step: null, assumptions: {}, estimates: [], writing: null };
    cloud.research.step = { id: "cloud-search-step", status: "running", phase: "search", error: null, created_at: new Date().toISOString() };
    scenarios.push({ id: "workspace:cloud-search-skipped", screen: "workspace", props: { view: cloud, isOwner: true, initialTab: "research" } });
    expect.set("workspace:cloud-search-skipped", {
      has: ["Running: Checking authorized public sources.", "workspace cloud model is authorized", "AI web search is not run for this engine", "website checks, PageSpeed and evidence rules still run"],
      hasNot: [/Handing the web search to CC's Mac/i, /Waiting for the web search on CC's Mac/i, /web search waits for CC's Mac/i],
    });
  }
  // The proposal editor's two ways out of a stuck draft: a waiting line takes its now-confirmed price in place,
  // and a tax rule set after the draft can be saved in without editing anything else.
  {
    const catalogueLib = await import("../lib/ai-audit/catalogue");
    const seed = catalogueLib.CATALOGUE_SEED[0];
    const item = { ...seed, id: "item-confirmed", tenant_id: tenantId, item_version: 1, status: "confirmed", is_fixture: false, created_by: null, created_at: "2026-10-27T00:00:00.000Z", updated_at: "2026-10-27T00:00:00.000Z", confirmed_by: ownerUserId, confirmed_at: "2026-10-27T00:00:00.000Z", retired_by: null, retired_at: null };
    const content = proposal.emptyProposal({ currency: seed.currency, tax: null, to: "owner@fixture.test", businessName: "Sample Co", contactName: "Test Owner", validUntil: "2026-12-31" });
    content.lines.push({ kind: "needs_owner_price", line_id: "l1", name: seed.name, description: seed.description, category: seed.category, unit: seed.unit, quantity: 1, optional: false, deliverables: seed.deliverables, onboarding_requirements: seed.onboarding_requirements, suggested_sku: seed.sku } as never);
    const sample = json(first as NonNullable<typeof first>);
    sample.engagement = { ...sample.engagement, stage: "generating" };
    sample.proposal = { ...(sample.proposal ?? {}), id: "proposal-sample", version_no: 1, status: "draft", content, content_sha256: "0".repeat(64), currency: seed.currency, total_cents: 0 } as never;
    sample.catalogue = [item] as never;
    sample.settings = { ...sample.settings, tax: { mode: "not_registered" } };
    scenarios.push({ id: "workspace:proposal-sample", screen: "workspace", props: { view: json(sample), isOwner: true, initialTab: "proposal" } });
    expect.set("workspace:proposal-sample", { has: ["Use the confirmed price", "The tax rule changed since this was saved"] });

    // USD core, paid in CAD (CC, 2026-10-27): a CAD proposal priced from the USD catalogue at CC's rate, as CC
    // sees it in the editor and as the client sees it on their page.
    const fx = { rate_ppm: 1_402_500, as_of: "2026-10-26", source: "bank_of_canada" as const };
    const converted = proposal.withConfirmedPrice(content.lines[0], item as never, proposal.itemPriceIn(item as never, "CAD", fx)!, "CAD");
    const cad = { ...content, currency: "CAD" as const, tax: { mode: "not_registered" as const }, lines: [converted] };
    const cadView = json(sample);
    cadView.proposal = { ...(cadView.proposal as object), content: cad, currency: "CAD" } as never;
    cadView.settings = { ...cadView.settings, tax: { mode: "not_registered" }, fx_usd_cad: fx } as never;
    scenarios.push({ id: "workspace:proposal-cad", screen: "workspace", props: { view: json(cadView), isOwner: true, initialTab: "proposal" } });
    expect.set("workspace:proposal-cad", { has: ["Converted from USD", "Converted from the catalogue at 1 USD = 1.4025 CAD"], hasNot: [/changed since this was saved/] });
    // Saved at 1.4025, the rate since changed to 1.5: stale, Save offered, and the note keeps the rate the lines carry
    // (Codex review of #752).
    const movedRate = json(cadView);
    movedRate.proposal = { ...(movedRate.proposal as object), content: cad } as never;
    (movedRate as unknown as { proposal: { content: unknown } }).proposal.content = cad;
    movedRate.settings = { ...movedRate.settings, fx_usd_cad: { rate_ppm: 1_500_000, as_of: "2026-10-28", source: "owner" } } as never;
    scenarios.push({ id: "workspace:proposal-cad-moved", screen: "workspace", props: { view: json(movedRate), isOwner: true, initialTab: "proposal" } });
    expect.set("workspace:proposal-cad-moved", { has: ["A price or the exchange rate changed since this was saved", "Converted from the catalogue at 1 USD = 1.4025 CAD"] });
    const firstDoc = scenarios.find((x) => x.screen === "document");
    if (firstDoc) {
      scenarios.push({
        id: "document:converted",
        screen: "document",
        props: json({ ...firstDoc.props, proposal: cad, totals: proposal.proposalTotals(cad) }),
      });
      expect.set("document:converted", { has: ["Prices are in CAD, converted from our USD prices at 1 USD = 1.4025 CAD"] });
    }
  }

  // The Needs-you cards the audit files (Gate 1, Gate 2, follow-ups), as the Feed builds them for the owner.
  const scope = { tenantId, userId: ownerUserId, persona: "founder" as const, canAct: true, allDepartments: true, departments: [] };
  const cardIds = (
    await db.execute({ sql: "SELECT id FROM approvals WHERE tenant_id = ? AND action_kind IN ('authorize_ai_audit', 'deliver_ai_audit', 'follow_up_ai_audit') ORDER BY created_at", args: [tenantId] })
  ).rows.map((r) => String(r.id));
  const rows = [];
  for (const cardId of cardIds) {
    const row = await approvalStore.getApproval(db, scope, cardId);
    if (row) rows.push(row);
  }
  for (const card of await approvalView.buildApprovalViews(db, scope, rows, { tenantSlug: "oasis-ai-cc", now: new Date() })) {
    for (const density of ["full", "compact"] as const) {
      const key = `approval:${card.id}:${card.action_kind}:${card.status}:${density}`;
      scenarios.push({ id: key, screen: "approval", props: { approval: json(card), density } });
      expect.set(key, {
        has: ["Free AI Audit", "Open the engagement", ...(card.action_kind === "deliver_ai_audit" ? ["Price", "Open the audit and its PDF"] : [])],
        hasNot: [RAW_CARD_TEXT, /\bUnattributed\b/],
      });
    }
  }
  const items = await catalogue.listCatalogue(db, tenantId);
  const { settings, rowVersion } = await store.getSettings(db, tenantId);
  // A saved six-digit rate is shown whole, so an unrelated save cannot round it (Codex review of #752).
  scenarios.push({ id: "settings:precise-rate", screen: "settings", props: { settings: json({ ...settings, fx_usd_cad: { rate_ppm: 1_402_567, as_of: "2026-10-27", source: "owner" } }), rowVersion, isOwner: true } });
  expect.set("settings:precise-rate", { html: ['value="1.402567"'] });
  for (const isOwner of [true, false]) {
    scenarios.push({ id: `catalogue:${isOwner ? "owner" : "admin"}`, screen: "catalogue", props: { items: json(items), isOwner } });
    scenarios.push({ id: `settings:${isOwner ? "owner" : "admin"}`, screen: "settings", props: { settings: json(settings), rowVersion, isOwner } });
  }
  // The setup checklist with nothing set up, and with everything set up and live.
  const now = new Date();
  const bare = await setup.setupChecks(db, tenantId, now, {
    isDryRun: () => true,
    linkSecretSet: () => false,
    pdfStorageSet: () => false,
    stripeConnected: async () => false,
    mailboxConnected: async () => false,
    runnerFor: async () => null,
    modelSearchEnabled: () => false,
  });
  const live = await setup.setupChecks(db, tenantId, now, {
    isDryRun: () => false,
    linkSecretSet: () => true,
    pdfStorageSet: () => true,
    stripeConnected: async () => true,
    mailboxConnected: async () => true,
    runnerFor: async () => ({ label: "oasis-mac-ai-audit", lastSeenAt: now.toISOString() }),
    modelSearchEnabled: () => true,
  });
  assert.ok(bare.some((c) => c.state === "missing"), "with nothing set up, setup says what is missing");
  const pdfOnly = await setup.setupChecks(db, tenantId, now, {
    isDryRun: () => false,
    linkSecretSet: () => true,
    pdfStorageSet: () => true,
    stripeConnected: async () => true,
    mailboxConnected: async () => true,
    runnerFor: async (_db, _t, tool) => (tool === "ai_audit_pdf" ? { label: "old-runner", lastSeenAt: now.toISOString() } : null),
    modelSearchEnabled: () => true,
  });
  const mac = pdfOnly.find((c) => c.key === "mac");
  const modelSearch = pdfOnly.find((c) => c.key === "model_search");
  const engine = settings.engine;
  assert.equal(mac?.state, "ready", "a PDF runner is ready independently of model/search retirement");
  if (engine === "mac_claude") {
    assert.equal(modelSearch?.state, "missing", "an enabled Mac engine still reports its missing model/search tools");
    assert.match(modelSearch?.detail ?? "", /ai_audit_model/);
  } else if (engine === "none") {
    assert.equal(modelSearch?.state, "deferred", "the No AI default is shown honestly");
  } else {
    assert.equal(modelSearch?.state, "ready", "the cloud engine does not depend on Mac model tools");
  }
  assert.equal(bare.filter((c) => c.state === "test_mode").length, 2, "both client-facing switches read as test mode");
  for (const k of ["mac", "pdf_storage", "link_secret", "mailbox", "stripe", "audit_email", "payments"] as const) {
    assert.equal(live.find((c) => c.key === k)?.state, "ready", `${k} reads ready when it is set up`);
  }
  scenarios.push({ id: "setup:bare", screen: "setup", props: { checks: json(bare) } });
  expect.set("setup:bare", { has: ["Needs you", "Test mode", "Deferred", "AI_AUDIT_MODEL_SEARCH_ENABLED", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "AI_AUDIT_LINK_SECRET"] });
  scenarios.push({ id: "setup:live", screen: "setup", props: { checks: json(live) } });
  expect.set("setup:live", { has: ["Online (oasis-mac-ai-audit", "Model and web search", "Deferred"] });

  // The render needs whole React: drop the suite's react-server condition, which CI passes in NODE_OPTIONS and a
  // child inherits (the same as tests/os-channels-honest.test.ts).
  const nodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
  if (!nodeOptions) delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ["--import", "tsx", "tests/ai-audit-ui.render.ts"], {
    input: JSON.stringify(scenarios),
    encoding: "utf8",
    env,
    maxBuffer: 512 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `the screen renderer failed: ${run.stderr?.slice(-2000)}`);
  const out = JSON.parse(run.stdout) as Record<string, { html?: string; error?: string }>;
  for (const s of scenarios) {
    const r = out[s.id];
    assert.ok(r, `${s.id} was not drawn`);
    assert.ok(!r.error && r.html, `${s.id} does not draw: ${r.error?.slice(0, 1500)}`);
    const text = visibleText(r.html as string);
    const bad = BROKEN_TEXT.exec(text);
    assert.ok(!bad, `${s.id} shows "${bad?.[0]}" near: ${text.slice(Math.max(0, (bad?.index ?? 0) - 120), (bad?.index ?? 0) + 120)}`);
    const want = expect.get(s.id);
    if (!want) continue;
    if (want.stage !== undefined) assert.ok(text.includes(want.stage), `${s.id} does not say its stage (${want.stage})`);
    if (want.next !== undefined) assert.ok(want.next.trim() && text.includes(`Next: ${want.next}`), `${s.id} does not say what comes next (${want.next})`);
    for (const words of want.has ?? []) assert.ok(text.includes(words), `${s.id} does not say "${words}": ${text.slice(0, 600)}`);
    for (const markup of want.html ?? []) assert.ok((r.html as string).includes(markup), `${s.id} has no ${markup}`);
    for (const re of want.hasNot ?? []) {
      const m = re.exec(text);
      assert.ok(!m, `${s.id} shows "${m?.[0]}" near: ${text.slice(Math.max(0, (m?.index ?? 0) - 120), (m?.index ?? 0) + 120)}`);
    }
  }
  return scenarios.length;
}
