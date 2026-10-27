/**
 * ai-audit-drafting.test.ts \u2014 phase 4a of the Free AI Audit: the first drafts
 * of the audit and its proposal, built by code from the stored research, on a
 * real libSQL file with the real migrations (bravo__186, 206, 237, 238, 239,
 * 240, 241, 243).
 *
 * Pins:
 *   - the drafted audit validates and has nothing blocking; it keeps nothing
 *     internal (no line numbers, call quotes, notes of CC's, budget, or
 *     questions written for CC); the client's own sources are one each;
 *   - every figure in its prose is a figure of what it cites;
 *   - opportunities follow the research's findings and estimates, the
 *     roadmap orders them, and a hand-typed id is never a catalogue lookup;
 *   - the proposal prices a line only from a confirmed catalogue version, one
 *     line per catalogue item, the rest "needs your price";
 *   - after Gate 1 the tick drafts the audit and proposal once, when research
 *     finishes; CC's press drafts again only when told to replace; only the
 *     owner presses it;
 *   - phase 4b: a model's opening prose is kept sentence by sentence, only
 *     where each figure is one its citations state (per the same period)
 *     and every other claim is one the draft states; the Mac's prompt holds
 *     the draft's facts and none of the call's words; an edit by CC while a
 *     pass runs wins; the cloud engine writes through the metered model; no
 *     engine, no pass.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-drafting.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { OASIS, USERS, check, finish, login, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];

const MAC_SECRET = "mac-runner-drafting-test-secret-0123456789abcdef";
const NOW = () => new Date();

function macRequest(route: string, body: Record<string, unknown>, now: Date): Request {
  const raw = JSON.stringify({ runner_id: "oasis-mac-audit", ...body });
  const ts = Math.floor(now.getTime() / 1000);
  const sig = createHmac("sha256", MAC_SECRET).update(`${ts}.${raw}`).digest("hex");
  return new Request(`https://oasisai.work/api/internal/tools/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tools-producer": "mac", "x-tools-timestamp": String(ts), "x-tools-signature": sig },
    body: raw,
  });
}

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

function fakeWeb(routes: Record<string, { status?: number; body?: string; type?: string; location?: string }>) {
  const origins = new Set(Object.keys(routes).map((u) => new URL(u).origin));
  return async (url: string) => {
    const r = routes[url];
    if (!r) {
      if (origins.has(new URL(url).origin)) return new Response("<html><title>Not found</title></html>", { status: 404, headers: { "content-type": "text/html" } });
      throw new TypeError("fetch failed");
    }
    const headers = new Headers({ "content-type": r.type ?? "text/html; charset=utf-8" });
    if (r.location) headers.set("location", r.location);
    return new Response(r.status && r.status >= 300 && r.status < 400 ? null : (r.body ?? ""), { status: r.status ?? 200, headers });
  };
}
const HOME = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Plumbing</title></head><body><main><h1>Plumbing</h1><p>${"We fix leaks and drains across the city. ".repeat(10)}</p></main></body></html>`;
const WEB = {
  "https://fixture-plumbing.ca/": { body: HOME },
  "https://fixture-plumbing.ca/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
  "http://fixture-plumbing.ca/": { status: 301, location: "https://fixture-plumbing.ca/" },
};
const LIGHTHOUSE = { lighthouseResult: { categories: { performance: { score: 0.35 }, accessibility: { score: 0.9 }, seo: { score: 0.8 } }, audits: { "largest-contentful-paint": { numericValue: 6200 } } } };

async function main() {
  const ex = await import("../lib/ai-audit/extract");
  const doc = await import("../lib/ai-audit/doc");
  const draft = await import("../lib/ai-audit/draft");
  const opps = await import("../lib/ai-audit/opportunities");
  const impact = await import("../lib/ai-audit/impact");
  const proposal = await import("../lib/ai-audit/proposal");

  console.log("the audit's first draft");
  const at = "2026-10-26T12:00:00.000Z";
  const src = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind,
    title,
    url: null,
    retrieved_at: at,
    http_status: null,
    content_sha256: null,
    excerpt: "",
    reliability: kind === "client" || kind === "other" ? "client_stated" : "own_measurement",
    published_at: null,
    confirmed_note: null,
    ...extra,
  });
  const pack = {
    schema: "ai_audit_research/v1",
    built_at: at,
    business: { name: "Fixture Plumbing", type: "local_service", website: "https://fixture-plumbing.ca", city: "Calgary" },
    plan: [],
    sources: [
      src("s-client-sales-missed-calls-per-week", "client", "Discovery call transcript, lines 4-5"),
      src("s-client-sales-close-rate-pct", "client", "CC's notes from the discovery call"),
      src("s-client-sales-avg-job-value", "client", "The client's audit form"),
      src("s-client-ops-admin-hours-per-week", "other", "Entered by CC", { confirmed_note: "Timesheets show it" }),
      src("s-client-decision-budget", "client", "CC's notes from the discovery call"),
      src("s-client-tech-tools", "client", "Discovery call transcript, lines 9-9"),
      src("s-site-1", "measurement", "Fixture Plumbing | Calgary plumbers, read by the Command Center", { url: "https://fixture-plumbing.ca/" }),
      src("s-pagespeed", "measurement", "Google PageSpeed Insights, phone view", { url: "https://fixture-plumbing.ca/" }),
      src("s-web-1", "listing", "Fixture Plumbing - Yelp", { url: "https://www.yelp.ca/biz/fixture-plumbing", reliability: "low" }),
    ],
    findings: [
      { id: "f-sales-missed-calls-per-week", title: "Missed calls per week", statement: "Missed calls per week: 10 calls/week.", label: "client_reported", metric: { value: 10, unit: "calls/week" }, source_ids: ["s-client-sales-missed-calls-per-week"] },
      { id: "f-sales-close-rate-pct", title: "Share of leads that become customers", statement: "Share of leads that become customers: 30 %.", label: "client_reported", metric: { value: 30, unit: "%" }, source_ids: ["s-client-sales-close-rate-pct"] },
      { id: "f-sales-avg-job-value", title: "Average job or order value", statement: "Average job or order value: 500.", label: "client_reported", metric: { value: 500, unit: "$" }, source_ids: ["s-client-sales-avg-job-value"] },
      { id: "f-ops-admin-hours-per-week", title: "Admin hours per week", statement: "Admin hours per week: 8 hours/week.", label: "verified", metric: { value: 8, unit: "hours/week" }, source_ids: ["s-client-ops-admin-hours-per-week"] },
      { id: "f-decision-budget", title: "Budget (only if they volunteered it)", statement: "Budget (only if they volunteered it): about five thousand.", label: "client_reported", source_ids: ["s-client-decision-budget"] },
      { id: "f-tech-tools", title: "Tools in use", statement: "Tools in use: Jobber, scheduling.", label: "client_reported", source_ids: ["s-client-tech-tools"] },
      { id: "f-site-online-booking", title: "Online booking", statement: "Visitors cannot book online from the pages read.", label: "verified", source_ids: ["s-site-1"] },
      { id: "f-ps-performance", title: "Speed", statement: "Google PageSpeed scores the home page 42 out of 100 for speed on a phone.", label: "verified", metric: { value: 42, unit: "/100" }, source_ids: ["s-pagespeed"] },
      { id: "f-web-1", title: "Fixture Plumbing - Yelp", statement: "Rated 4.8 stars from 120 reviews", label: "verified", metric: { value: 4.8, unit: "stars" }, source_ids: ["s-web-1"] },
      {
        id: "h-booking-by-hand",
        title: "Likely problem",
        statement: "Appointments are probably booked by phone, text or email, which takes someone's time and stops after hours.",
        label: "hypothesis",
        source_ids: ["s-site-1"],
        how_to_test: "Ask how a new customer books today, who answers, and what happens to a request that comes in at night.",
      },
      { id: "h-no-tap-to-call", title: "Likely problem", statement: "Phone visitors have to copy the number to call, which can lose some calls.", label: "hypothesis", source_ids: ["s-site-1"], how_to_test: "Ask how most new customers first get in touch." },
    ],
    impact_inputs: {
      "sales.missed_calls_per_week": { value: 10, label: "client_reported", sourceId: "s-client-sales-missed-calls-per-week" },
      "sales.close_rate_pct": { value: 30, label: "client_reported", sourceId: "s-client-sales-close-rate-pct" },
      "sales.avg_job_value": { value: 500, label: "client_reported", sourceId: "s-client-sales-avg-job-value" },
      "ops.admin_hours_per_week": { value: 8, label: "verified", sourceId: "s-client-ops-admin-hours-per-week" },
    },
    estimates: [],
    gaps: [
      { topic: "Website speed", why: "PageSpeed answered HTTP 500." },
      { topic: "Cost of admin time saved", why: "To estimate this, the audit needs: cost of an hour of staff time." },
    ],
    evidence_changes: [],
    search_refused: [],
  } as never;
  const estimates = impact.estimateImpact((pack as { impact_inputs: never }).impact_inputs).estimates;
  const built = draft.draftAuditDoc({
    business: { name: "Fixture Plumbing", type: "local_service", location: "Calgary", website: "https://fixture-plumbing.ca" },
    contactName: "Dana Smith",
    today: "2026-10-26",
    pack,
    estimates,
    tools: [{ name: "Jobber", role: "Scheduling" }],
  });
  const d = built.doc;

  await check("the draft validates, and nothing in it blocks submission", () => {
    const v = doc.validateAuditDoc(d);
    assert.ok(v.ok, v.ok ? "" : `${v.path}: ${v.message}`);
    const blocking = doc.auditDocIssues(d).filter((i) => i.severity === "block");
    assert.deepEqual(blocking, []);
  });
  await check("nothing internal reaches the client: no line numbers, notes, budget, questions written for CC, or a gap with a figure", () => {
    const raw = JSON.stringify(d);
    for (const bad of ["lines 4", "lines 9", "read by the Command Center", "Ask how", "CC's notes", "Entered by CC", "Timesheets", "Budget", "five thousand", "HTTP 500"]) assert.ok(!raw.includes(bad), `the draft says "${bad}"`);
    assert.deepEqual(
      d.sources.filter((s) => s.kind === "client" || s.kind === "other").map((s) => [s.id, s.title]),
      [["src-call", "Our discovery call with you"], ["src-form", "Your answers on the audit form"], ["src-confirmed", "Confirmed with you"]],
      "the client's own sources are one each",
    );
    assert.ok(d.findings.find((f) => f.id === "f-sales-avg-job-value")?.source_ids.includes("src-form"));
    assert.ok(d.findings.find((f) => f.id === "f-ops-admin-hours-per-week")?.source_ids.includes("src-confirmed"));
    assert.match(String(d.findings.find((f) => f.id === "h-booking-by-hand")?.how_to_test), /^We would look together at how bookings arrive today/);
    assert.ok(d.sources.some((s) => s.title === "Your website: Fixture Plumbing | Calgary plumbers"));
    assert.deepEqual(d.gaps.map((g) => [g.topic, g.why]), [
      ["Website speed", "We could not measure how fast your website loads on a phone."],
      ["Cost of admin time saved", "To size this, we would need: cost of an hour of staff time."],
    ]);
    const hours = d.estimates.find((e) => e.id === "est-admin-hours")!;
    assert.equal(hours.inputs.find((x) => x.label === "verified")?.basis, "src-confirmed", "a verified input names a source in this audit");
  });
  await check("every figure the prose states is a figure of what it cites", () => {
    const facts = new Map<string, string>([
      ...d.findings.map((f) => [f.id, `${f.statement} ${f.metric?.value ?? ""}`] as [string, string]),
      ...d.estimates.map((e) => [e.id, `${e.low} ${e.high}`] as [string, string]),
    ]);
    const paragraphs = [
      ...d.sections.executive_overview.paragraphs,
      ...d.sections.current_assessment.paragraphs,
      ...d.sections.inefficiencies.items.flatMap((i) => [i.why_it_matters, i.consequence]),
      ...d.sections.opportunities.items.map((o) => o.expected_improvement),
      ...(d.sections.impact.intro ? [d.sections.impact.intro] : []),
    ];
    let checked = 0;
    for (const p of paragraphs) {
      const said = ex.numbersIn(p.text);
      if (!said.length) continue;
      const cited = ex.numbersIn(p.cites.map((c) => facts.get(c) ?? "").join(" "));
      for (const n of said) assert.ok(cited.some((m) => Math.abs(m - n) < 1e-9), `"${p.text}" states ${n}, which nothing it cites states`);
      checked += 1;
    }
    assert.ok(checked >= 3, "the figures are in the prose, and checked");
    for (const o of d.sections.opportunities.items) {
      for (const t of [o.title, o.what_it_does, o.problem, o.how_it_works, ...(o.workflow?.before ?? []), ...(o.workflow?.after ?? [])]) assert.ok(!doc.statesFigure(t), `"${t}" states a figure`);
    }
  });
  await check("opportunities follow the research, sized where an estimate exists; the roadmap starts with the quick wins", () => {
    const ids = d.sections.opportunities.items.map((o) => o.id);
    for (const want of ["answer-missed-calls", "admin-automation", "online-booking", "website-enquiries", "website-speed"]) assert.ok(ids.includes(want), `${want} is in ${ids.join(", ")}`);
    for (const not of ["connect-systems", "own-website", "secure-site", "measure-website", "fast-lead-replies"]) assert.ok(!ids.includes(not), `${not} has nothing to rest on`);
    const missed = d.sections.opportunities.items.find((o) => o.id === "answer-missed-calls")!;
    assert.deepEqual(missed.estimate_ids, ["est-missed-calls"]);
    assert.match(missed.expected_improvement.text, /\$1,300 to \$3,250 per month/);
    assert.ok(missed.integrations.includes("Jobber"), "the client's own tools are named");
    assert.deepEqual(d.sections.roadmap.now.map((r) => r.opportunity_id), ["answer-missed-calls"]);
    assert.equal(d.sections.current_assessment.systems[0]?.name, "Jobber");
    assert.equal(opps.OPPORTUNITY_SKU.get("constructor"), undefined, "an id CC typed is never an object's own key");
  });
  await check("the AI sales setter's tier is the catalogue's: one lead source is launch, several are scale; complete is CC's to pick", () => {
    const tier = (said: string | null, leads?: number) => {
      const findings = [
        ...(said === null ? [] : [{ id: "f-sales-lead-sources", title: "Where leads come from", statement: `Where leads come from: ${said}.`, label: "client_reported", source_ids: [] }]),
        ...(leads === undefined ? [] : [{ id: "f-sales-leads-per-month", title: "Leads per month", statement: `Leads per month: ${leads} leads/month.`, label: "client_reported", metric: { value: leads, unit: "leads/month" }, source_ids: [] }]),
      ];
      return opps.setterSku({ findings, estimates: [], tools: [] } as never);
    };
    assert.equal(tier(null), "checkout-sales-setter-launch", "nothing said: the smallest tier");
    assert.equal(tier("Google, 40"), "checkout-sales-setter-launch");
    assert.equal(tier("Google, 40; referrals, 10"), "checkout-sales-setter-scale");
    assert.equal(tier("Google, 40; referrals, 10; Instagram; walk-ins"), "checkout-sales-setter-scale", "no figure picks the complete tier");
    assert.equal(tier("Google, 40", 400), "checkout-sales-setter-launch", "volume alone is not a catalogue rule");
  });

  console.log("the proposal's first draft");
  await check("a line is priced only from a confirmed catalogue version; one line per item; the rest need CC's price", () => {
    const confirmed = [
      { id: "cat-1", tenant_id: OASIS, item_version: 2, status: "confirmed", is_fixture: false, sku: "checkout-sales-setter-launch", name: "AI sales setter, launch", description: "One lead source.", category: "implementation", unit: "fixed", price_cents: 150_000, currency: "CAD", deliverables: ["Setup"], onboarding_requirements: ["Phone access"], source_ref: { file: "x" } },
      { id: "cat-0", tenant_id: OASIS, item_version: 1, status: "retired", is_fixture: false, sku: "fleet-custom-integration", name: "Old", description: "Old.", category: "implementation", unit: "fixed", price_cents: 1, currency: "CAD", deliverables: [], onboarding_requirements: [], source_ref: { file: "x" } },
    ] as never;
    const planned = [...built.opportunities, { ...built.opportunities[0], id: "fast-lead-replies", sku: "checkout-sales-setter-launch" }];
    const p = draft.draftProposal({
      opportunities: planned,
      roadmap: d.sections.roadmap,
      confirmed,
      currency: "CAD",
      tax: { mode: "not_registered" },
      depositBps: null,
      to: "owner@fixture.test",
      businessName: "Fixture Plumbing",
      contactName: "Dana Smith",
      today: "2026-10-26",
    });
    const v = proposal.validateProposalContent(p);
    assert.ok(v.ok, v.ok ? "" : JSON.stringify(v));
    const bySku = p.lines.map((l) => [l.kind, l.kind === "catalogue" ? l.sku : l.kind === "needs_owner_price" ? l.suggested_sku : ""]);
    // In the opportunities' order (most valuable, least effort first); two opportunities on one item are one line.
    assert.deepEqual(bySku, [["catalogue", "checkout-sales-setter-launch"], ["needs_owner_price", "checkout-conversion-sprint-focused"], ["needs_owner_price", "fleet-custom-integration"]]);
    const priced = p.lines[0];
    assert.ok(priced.kind === "catalogue" && priced.unit_price_cents === 150_000 && priced.item_version === 2);
    assert.equal(p.valid_until, "2026-11-25");
    assert.equal(p.delivery_email.body.split(proposal.AUDIT_LINK_PLACEHOLDER).length, 2, "exactly one link placeholder");
    assert.ok(proposal.proposalBlockers(p, "2026-10-26").length >= 1, "a line without a price blocks submission");
    assert.equal(p.phases[0]?.name, "Start now");
    // USD core (CC, 2026-10-27): the same item priced in USD drafts into a CAD proposal converted at CC's rate,
    // and into nothing without one.
    const usdItem = [{ ...(confirmed as unknown as Array<Record<string, unknown>>)[0], currency: "USD", price_cents: 350_000 }] as never;
    const args = { opportunities: planned, roadmap: d.sections.roadmap, confirmed: usdItem, currency: "CAD" as const, tax: { mode: "not_registered" as const }, depositBps: null, to: "owner@fixture.test", businessName: "Fixture Plumbing", contactName: "Dana Smith", today: "2026-10-26" };
    const cad = draft.draftProposal({ ...args, fx: { rate_ppm: 1_402_500, as_of: "2026-10-26", source: "bank_of_canada" as const } });
    const first = cad.lines[0];
    assert.ok(first.kind === "catalogue" && first.currency === "CAD" && first.unit_price_cents === 490_875 && first.fx?.from_unit_price_cents === 350_000, JSON.stringify(first));
    assert.ok(proposal.validateProposalContent(cad).ok);
    assert.equal(draft.draftProposal({ ...args, fx: null }).lines[0].kind, "needs_owner_price", "no rate: the line waits for CC's price");
  });
  await check("firm for now, open for later: a line only the Later column needs is an optional add-on outside the total", () => {
    const confirmed = [
      { id: "cat-a", tenant_id: OASIS, item_version: 1, status: "confirmed", is_fixture: false, sku: "checkout-sales-setter-launch", name: "AI sales setter, launch", description: "One lead source.", category: "implementation", unit: "fixed", price_cents: 150_000, currency: "CAD", deliverables: ["Setup"], onboarding_requirements: [], source_ref: { file: "x" } },
      { id: "cat-b", tenant_id: OASIS, item_version: 1, status: "confirmed", is_fixture: false, sku: "fleet-custom-integration", name: "Custom integration", description: "One integration.", category: "implementation", unit: "fixed", price_cents: 90_000, currency: "CAD", deliverables: ["Integration"], onboarding_requirements: [], source_ref: { file: "x" } },
    ] as never;
    const setter = { ...built.opportunities[0], id: "o-now", sku: "checkout-sales-setter-launch" };
    const later = { ...built.opportunities[0], id: "o-later", sku: "fleet-custom-integration" };
    const item = (id: string) => ({ ...d.sections.roadmap.now[0], opportunity_id: id });
    const base = { opportunities: [setter, later], confirmed, currency: "CAD" as const, tax: { mode: "not_registered" as const }, depositBps: null, to: "owner@fixture.test", businessName: "Fixture Plumbing", contactName: "Dana Smith", today: "2026-10-26" };
    const p = draft.draftProposal({ ...base, roadmap: { now: [item("o-now")], next: [], later: [item("o-later")] } });
    assert.ok(proposal.validateProposalContent(p).ok);
    assert.deepEqual(p.lines.map((l) => [l.kind === "catalogue" ? l.sku : "", l.optional]), [["checkout-sales-setter-launch", false], ["fleet-custom-integration", true]]);
    const t = proposal.proposalTotals(p);
    assert.deepEqual([t.subtotal_cents, t.optional_cents], [150_000, 90_000], "the add-on is priced but not in the total");
    // An item the Now column also needs is not optional, even if a Later opportunity shares it.
    const shared = draft.draftProposal({ ...base, opportunities: [setter, { ...later, sku: "checkout-sales-setter-launch" }], roadmap: { now: [item("o-now")], next: [], later: [item("o-later")] } });
    assert.deepEqual(shared.lines.map((l) => l.optional), [false]);
    // Everything for later: all of it stays in, so the proposal still has something due.
    const allLater = draft.draftProposal({ ...base, roadmap: { now: [], next: [], later: [item("o-now"), item("o-later")] } });
    assert.deepEqual(allLater.lines.map((l) => l.optional), [false, false]);
  });
  await check("review of #759: payback is the full price against revenue the priced work makes, less fees, or nothing", async () => {
    const { paybackFor } = await import("../lib/ai-audit/payback");
    const est = d.estimates.find((e) => e.id === "est-missed-calls")!;
    assert.deepEqual([est.low, est.high], [1300, 3250]);
    // CC records what the client's figures are in; this client spoke in Canadian dollars, as the proposal is priced.
    const dc = { ...d, business: { ...d.business, currency: "CAD" as const } };
    const line = (over: Record<string, unknown> = {}) => ({ line_id: "l1", kind: "catalogue", sku: "checkout-sales-setter-launch", item_id: "cat-a", item_version: 1, name: "AI sales setter", description: "x", category: "implementation", unit: "fixed", quantity: 1, optional: false, unit_price_cents: 150_000, currency: "CAD", deliverables: [], onboarding_requirements: [], ...over });
    const prop = (lines: unknown[], terms: unknown = { kind: "full" }) => ({ ...draft.draftProposal({ opportunities: [], roadmap: d.sections.roadmap, confirmed: [] as never, currency: "CAD", tax: { mode: "not_registered" }, depositBps: null, to: "owner@fixture.test", businessName: "Fixture Plumbing", contactName: "Dana Smith", today: "2026-10-26" }), lines, payment_terms: terms }) as never;
    const pay = (p: never, base: typeof d = dc) => paybackFor(base, p, proposal.proposalTotals(p));
    const full = pay(prop([line()]));
    assert.ok(full && full.estimate.id === "est-missed-calls" && full.investment === 1500, JSON.stringify(full));
    assert.deepEqual([full!.fast, full!.slow], [1, 2]);
    // A 25% deposit is what is due to start, not what the work costs: payback still counts all of it.
    const deposit = pay(prop([line({ unit_price_cents: 1_000_000 })], { kind: "deposit", deposit_bps: 2500, balance_due: "on launch" }));
    assert.deepEqual([deposit!.investment, deposit!.fast, deposit!.slow], [10_000, 4, 8]);
    // A monthly fee comes off the monthly value; one larger than the low end leaves nothing to claim.
    const fee = (cents: number) => line({ line_id: "l2", sku: "command-managed-monthly", unit: "per_month", unit_price_cents: cents });
    assert.deepEqual(((p) => [p!.monthlyFees, p!.fast, p!.slow])(pay(prop([line(), fee(30_000)]))), [300, 1, 2]);
    assert.equal(pay(prop([line(), fee(140_000)])), null);
    // The setter left out of the total (an optional add-on), or not in the proposal at all: no payback from its revenue.
    assert.equal(pay(prop([line({ optional: true }), line({ line_id: "l3", sku: "fleet-custom-integration" })])), null);
    assert.equal(pay(prop([line({ sku: "fleet-custom-integration" })])), null);
    // A tier CC changed is still the same setter.
    assert.ok(pay(prop([line({ sku: "checkout-sales-setter-complete" })])));
    // Staff time is not revenue: an opportunity resting on a money estimate that is not revenue claims no payback.
    const costOnly = { ...dc, estimates: d.estimates.map((e) => (e.id === "est-missed-calls" ? { ...e, id: "est-admin-cost" } : e)), sections: { ...d.sections, opportunities: { ...d.sections.opportunities, items: d.sections.opportunities.items.map((o) => ({ ...o, estimate_ids: o.estimate_ids.map((x) => (x === "est-missed-calls" ? "est-admin-cost" : x)) })) } } };
    const p0 = prop([line()]);
    assert.equal(paybackFor(costOnly as never, p0, proposal.proposalTotals(p0)), null);
    // Round two: no currency recorded, or another currency than the proposal's, and nothing is claimed.
    assert.equal(pay(prop([line()]), d), null, "the client's currency is not recorded");
    assert.equal(pay({ ...(prop([line()]) as object), currency: "USD" } as never), null, "CAD figures against a USD price");
    // Only a monthly period, and only an estimate section 7 shows.
    const per = (period: string) => ({ ...dc, estimates: dc.estimates.map((e) => (e.id === "est-missed-calls" ? { ...e, period } : e)) });
    assert.equal(pay(prop([line()]), per("per 3 months")), null);
    assert.ok(pay(prop([line()]), per("Monthly")));
    const hidden = { ...dc, sections: { ...dc.sections, impact: { ...dc.sections.impact, estimate_ids: dc.sections.impact.estimate_ids.filter((x) => x !== "est-missed-calls") } } };
    assert.equal(pay(prop([line()]), hidden), null, "an estimate CC took off the page is not on the cover either");
    // The recorded currency survives validation, and anything else is refused.
    const v = doc.validateAuditDoc(dc);
    assert.ok(v.ok && v.doc.business.currency === "CAD");
    assert.equal(doc.validateAuditDoc({ ...d, business: { ...d.business, currency: "EUR" } }).ok, false);
    // Both ends said once when they round to the same month (CodeRabbit, #759).
    const { monthsWords } = await import("../lib/ai-audit/payback");
    assert.deepEqual([monthsWords(1, 1), monthsWords(2, 2), monthsWords(3, 7)], ["1 month", "2 months", "3 to 7 months"]);
    // A line still waiting for CC's price: no payback yet.
    assert.equal(pay(prop([line(), { ...line({ line_id: "l4" }), kind: "needs_owner_price", suggested_sku: "website-starter" }])), null);
  });


  console.log("the opening, rewritten by a model and checked");
  const prose = await import("../lib/ai-audit/prose");
  // A paragraph citing every fact, so each sentence below is checked against just what it cites.
  const ALL = [...d.findings.map((f) => f.id), ...d.estimates.map((e) => e.id), "src-call"];
  const framed = (text = "Here is what the audit found.", base: typeof d = d) => ({ ...base, sections: { ...base.sections, current_assessment: { ...base.sections.current_assessment, paragraphs: [{ text, cites: ALL }] } } });
  const one = (text: string, cites: string[], base = framed()) => {
    const r = prose.checkProse(JSON.stringify({ current_assessment: [{ sentences: [{ text, cites }] }] }), base);
    assert.ok(r.ok);
    return r.ok ? (r.value.withheld[0]?.reason ?? "kept") : "";
  };
  const calls = ["f-sales-missed-calls-per-week"];
  const looseWord = /^it uses a word its paragraph and facts do not/;

  await check("a rewrite replaces only its own paragraph, and only when every sentence in it stands and no figure is dropped", () => {
    const told = d.sections.current_assessment.paragraphs[0];
    assert.equal(told.text, "What you told us: you miss about 10 calls a week; about 30% of your leads become customers; and an average job or order is worth about $500.");
    const answer = JSON.stringify({
      executive_overview: [{ sentences: [{ text: "We guarantee it will double your bookings.", cites: [] }] }],
      current_assessment: [{ sentences: [{ text: "You told us you miss about 10 calls a week, that about 30% of your leads become customers, and that an average job or order is worth about $500.", cites: told.cites }] }],
      key_findings_intro: [{ sentences: [{ text: "Each finding carries one label: Verified fact, Client-reported, or Hypothesis.", cites: [] }] }],
      impact_intro: [{ sentences: [{ text: "HubSpot says most shops win back 80 percent of missed calls.", cites: [] }] }],
    });
    const r = prose.checkProse(answer, d);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.parts.executive_overview, undefined, "a promise keeps the code paragraph");
    assert.ok(r.value.parts.current_assessment?.[0], JSON.stringify(r.value.withheld));
    assert.ok(r.value.parts.key_findings_intro?.[0]);
    assert.equal(r.value.parts.impact_intro, undefined);
    const reasons = r.value.withheld.map((w) => `${w.part}: ${w.reason}`);
    assert.ok(reasons.some((x) => /^executive_overview: it promises a result/.test(x)), reasons.join(" | "));
    assert.ok(reasons.some((x) => /^impact_intro: /.test(x)), reasons.join(" | "));
    const next = prose.applyProse(d, r.value);
    assert.deepEqual(next.sections.executive_overview, d.sections.executive_overview, "every code paragraph stays where its rewrite failed");
    assert.equal(next.sections.current_assessment.paragraphs.length, d.sections.current_assessment.paragraphs.length, "no paragraph is lost");
    assert.match(next.sections.current_assessment.paragraphs[0].text, /^You told us you miss about 10 calls a week/);
    assert.deepEqual(next.sections.current_assessment.paragraphs.slice(1), d.sections.current_assessment.paragraphs.slice(1));
    assert.deepEqual(doc.auditDocIssues(next).filter((i) => i.severity === "block"), []);
    const dropped = prose.checkProse(JSON.stringify({ current_assessment: [{ sentences: [{ text: "You told us you miss about 10 calls a week.", cites: told.cites }] }] }), d);
    assert.ok(dropped.ok && !dropped.value.parts.current_assessment, "a rewrite that drops a figure keeps the paragraph");
    assert.match(dropped.ok ? dropped.value.withheld[0].reason : "", /^it leaves out 30/);
    const outOfParagraph = prose.checkProse(JSON.stringify({ current_assessment: [{ sentences: [{ text: "You told us you miss about 10 calls a week, that about 30% of your leads become customers, and that an average job or order is worth about $500.", cites: ["est-missed-calls"] }] }] }), d);
    assert.ok(outOfParagraph.ok && !outOfParagraph.value.parts.current_assessment, "a sentence cites only what its paragraph cites");
    assert.deepEqual(prose.checkProse("not json at all", d), { ok: false, error: "unreadable" });
    assert.deepEqual(prose.checkProse("{".repeat(200_000), d), { ok: false, error: "unreadable" }, "an answer longer than any real one is not read");
    const p = prose.prosePrompt(d);
    assert.match(p.prompt, /UNTRUSTED_INPUT_BEGIN[\s\S]*f-sales-missed-calls-per-week/);
    assert.match(p.system, /Keep every figure exactly as given/);
  });

  await check("a figure keeps its kind and period, is written in digits, and nothing new slips in beside it", () => {
    assert.equal(one("You miss 10 calls a month.", calls), "it states 10 a month; what it cites gives 10 a week");
    assert.equal(one("Missed calls lose you 10 jobs every year.", calls), "it states 10 a year; what it cites gives 10 a week");
    assert.equal(one("You missed 10 calls last month.", calls), "it states 10 a month; what it cites gives 10 a week");
    assert.equal(one("You miss 10 calls.", calls), "it states 10 with no period; what it cites gives 10 a week");
    assert.equal(one("Each week about 10 calls are missed.", calls), "kept");
    assert.equal(one("Fixture Plumbing misses 10 calls a week.", calls), "kept");
    assert.match(one("You miss ten calls a week.", calls), /^it writes a figure in a form the check cannot match/);
    assert.match(one("Half of your calls go unanswered.", calls), /^it writes a figure in a form the check cannot match/);
    assert.match(one("You miss \u0661\u0660 calls a week.", calls), /^it writes a figure in a form the check cannot match/);
    assert.equal(one("Missed calls could be won back: $1,300\u2013$3,250 a month.", ["est-missed-calls"]), "kept");
    assert.equal(one("Missed calls could be won back: $1,300 to $3,250 a week.", ["est-missed-calls"]), "it states 1,300 a week; what it cites gives 1,300 a month");
    assert.equal(one("Missed calls could be won back: $1,300 to $3,250 over the next year.", ["est-missed-calls"]), "it states 1,300 a year; what it cites gives 1,300 a month");
    assert.equal(one("Each month, $1,300 to $3,250 could come back.", ["est-missed-calls"]), "kept");
    assert.equal(one("Admin takes 8 hours a week, and automation could take 1.5 hours to 3 hours of it each week.", ["f-ops-admin-hours-per-week", "est-admin-hours"]), "kept");
    assert.equal(one("Admin takes 10 hours a week.", [...calls, "f-ops-admin-hours-per-week"]), "it counts 10 hours, but what it cites counts something else");
    assert.match(one("You miss 500 calls.", [...calls, "f-sales-avg-job-value"]), /^it (?:states 500 as a count, but what it cites gives 500 as an amount of money|counts 500 calls, but what it cites counts something else)/);
    assert.match(one("You close 30 jobs.", ["f-sales-close-rate-pct"]), /^it states 30 as a count, but what it cites gives 30 as a share/);
    assert.equal(one("PageSpeed scores your home page 42 out of 100 on a phone.", ["f-ps-performance"]), "kept");
    assert.equal(one("You miss 10 calls a week, and 30% of your leads become customers.", [...calls, "f-sales-close-rate-pct"]), "kept", "a period another figure took is not this one's");
    assert.equal(one("30 per cent of your leads become customers.", ["f-sales-close-rate-pct"]), "kept");
    assert.equal(one("It answers calls 24/7.", []), "it states a figure without citing where it comes from");
    assert.equal(one("24 Hour Plumbing misses 10 calls a week.", calls, framed(undefined, { ...d, business: { ...d.business, name: "24 Hour Plumbing" } })), "kept", "a digit in the business's own name is no figure");
    const sourced = prose.checkProse(JSON.stringify({ current_assessment: [{ sentences: [{ text: "This audit is based on our call with you.", cites: ["src-call", "s-not-here"] }] }] }), framed());
    assert.ok(sourced.ok && sourced.value.parts.current_assessment?.[0]?.cites.join() === "src-call", "a source id the paragraph cites is kept as a cite");
  });

  await check("review of phase 4, third round: a rewrite keeps its facts' yes or no, adds no bound or result, and uses only its own words", () => {
    // N1: built from the audit's words, each still says something its facts do not.
    assert.equal(one("You do not miss calls.", calls), 'it says "not" where its paragraph and facts do not');
    assert.equal(one("Visitors can book online.", ["f-site-online-booking"]), 'it drops a "not" its facts have');
    assert.equal(one("Visitors cannot book online from the pages read.", ["f-site-online-booking"]), "kept");
    assert.match(one("Your website is fast on a phone.", ["f-ps-performance"]), looseWord);
    assert.match(one("You miss more than 10 calls a week.", calls), /^it adds a comparison \("more"\)/);
    assert.match(one("Missed calls could be won back: more than $3,250 a month.", ["est-missed-calls"]), /^it adds a comparison \("more"\)/);
    assert.match(one("Automation could save 8 hours a week.", ["f-ops-admin-hours-per-week"]), /^it claims a result \("save"\)/);
    assert.match(one("You lose 30% of your leads.", ["f-sales-close-rate-pct"]), looseWord);
    assert.match(one("You win more work.", []), /^it adds a comparison \("more"\)/);
    assert.match(one("Booker offers customers a time to book.", ["f-tech-tools"]), looseWord);
    assert.match(one("Zapier connects your calendar.", ["f-tech-tools"]), /\("zapier"\)$/);
    assert.match(one("Twilio can text callers back.", ["f-tech-tools"]), /\("twilio"\)$/);
    assert.match(one("Fixture Plumbing books its jobs in ServiceTitan.", ["f-tech-tools"]), looseWord);
    assert.equal(one("We can set this up in a week.", []), 'it uses a word its paragraph and facts do not ("week")');
    assert.equal(one("The most valuable change is answering missed calls.", []), 'it uses a word its paragraph and facts do not ("valuable")');
    // Promises, prices and general rules, however phrased.
    for (const promise of ["You will never miss a call again.", "Your bookings will rise.", "This pays for itself.", "This would pay for itself.", "We guarantee results."]) assert.equal(one(promise, calls), "it promises a result", promise);
    for (const price of ["Setup is free.", "It costs less than a part-time hire."]) assert.match(one(price, []), /^it speaks of prices, costs or payment/, price);
    for (const rule of ["Most owners lose work this way.", "Most people hang up on voicemail.", "Businesses like yours often lose calls.", "Studies show that callers rarely leave a message."]) assert.equal(one(rule, calls), "it states a general rule the audit's facts do not", rule);
    // A likely problem stays likely, sentence by sentence.
    assert.match(one("Phone visitors have to copy your number to call, so you lose calls.", ["h-no-tap-to-call"]), /^it states a likely problem as a fact/);
    assert.equal(one("Phone visitors may have to copy your number to call, which can lose some calls.", ["h-no-tap-to-call"]), "kept");
    // N2: the false holds the review measured.
    assert.equal(one("Visitors could call in one tap.", ["h-no-tap-to-call"], framed("Here is what the audit found. Visitors can call in one tap.")), "kept", "a number word its own paragraph says the same way");
    assert.equal(one("The average job or order is worth about $500.", ["f-sales-avg-job-value"], framed("Here is what the audit found. An average job or order is worth about $500.")), "kept", "the average of the client's own figure is no general rule");
    assert.ok(!/^it speaks of prices/.test(one("Automation could free up 1.5 hours to 3 hours each week.", ["est-admin-hours"])), "free up is time, not money");
    assert.equal(one("A visitor may try to call.", [], framed("Here is what the audit found. A visitor who tries to call has to copy the number.")), "kept", "tries is try");
    assert.equal(one("The estimates are ranges, not promises.", []), "kept", "a disclaimer is not a promise, nor a denial");
  });

  await check("review of phase 4: the client's audit names only what it drew on, says likely problems in the client's words, and leaves the rest out", () => {
    const pack2 = {
      ...(pack as Record<string, unknown>),
      plan: [{ module: "profile", status: "done", detail: "" }, { module: "site", status: "skipped", detail: "" }, { module: "pagespeed", status: "skipped", detail: "" }, { module: "search", status: "skipped", detail: "" }],
      sources: (pack as { sources: Array<{ id: string }> }).sources.filter((x) => x.id.startsWith("s-client")),
      findings: [
        ...(pack as { findings: Array<{ id: string }> }).findings.filter((x) => x.id.startsWith("f-sales")),
        { id: "h-shelfware", title: "Likely problem", statement: "They have paid for tools nobody uses, so getting the team to use something is likely the real problem, not features.", label: "hypothesis", source_ids: [], how_to_test: "Ask which tools they bought." },
        { id: "h-made-up", title: "Likely problem", statement: "Ask them about it.", label: "hypothesis", source_ids: [] },
        { id: "f-web-9", title: "A page", statement: "Offers emergency service around the clock", label: "hypothesis", source_ids: [] },
      ],
      gaps: [
        { topic: "Website", why: "No AI-audit form answers are on file for this lead." },
        { topic: "Web search", why: "The web search on the Mac failed (model_timeout)." },
        { topic: "Web search", why: "yelp.ca could not be read (timeout)." },
        { topic: "Budget (only if they volunteered it)", why: "The discovery profile does not have it." },
      ],
    } as never;
    const b = draft.draftAuditDoc({ business: { name: "Fixture Plumbing", type: "local_service", location: "Calgary", website: null }, contactName: "Dana Smith", today: "2026-10-26", pack: pack2, estimates, tools: [] }).doc;
    assert.equal(b.sections.executive_overview.paragraphs[0].text.match(/It draws on (.*)\./)?.[1], "our call with you and your answers on the audit form");
    const raw = JSON.stringify(b);
    for (const bad of ["form answers are on file", "on the Mac", "model_timeout", "Budget", "They have paid", "Ask them", "emergency service around the clock"]) assert.ok(!raw.includes(bad), `the client's audit says "${bad}"`);
    assert.deepEqual(b.gaps.map((g) => g.topic), ["Public listings"]);
    // Third round, N5: no website is said as such; an internal gap alone raises no "listed at the end"; our checks, never the Command Center.
    const noSite = draft.draftAuditDoc({
      business: { name: "Fixture Plumbing", type: "local_service", location: "Calgary", website: null },
      contactName: "Dana Smith",
      today: "2026-10-26",
      pack: { ...(pack2 as Record<string, unknown>), gaps: [{ topic: "Website", why: "No website is known for the business." }] } as never,
      estimates,
      tools: [],
    }).doc;
    assert.deepEqual(noSite.gaps.map((g) => g.why), ["We did not find a website for the business, so none was reviewed."]);
    const internalOnly = draft.draftAuditDoc({
      business: { name: "Fixture Plumbing", type: "local_service", location: "Calgary", website: null },
      contactName: "Dana Smith",
      today: "2026-10-26",
      pack: { ...(pack2 as Record<string, unknown>), gaps: [{ topic: "Website", why: "No AI-audit form answers are on file for this lead." }] } as never,
      estimates,
      tools: [],
    }).doc;
    assert.ok(!internalOnly.sections.executive_overview.paragraphs.some((x) => /could not be checked/.test(x.text)), "no promise of a list that is empty");
    const timed = draft.draftAuditDoc({
      business: { name: "Fixture Plumbing", type: "local_service", location: "Calgary", website: "https://fixture-plumbing.ca" },
      contactName: "Dana Smith",
      today: "2026-10-26",
      pack: {
        ...(pack as Record<string, unknown>),
        findings: [{ id: "f-site-response-time", title: "Response time", statement: "The home page answered in 1.2 seconds (one measurement, from the Command Center's servers, not the visitor's phone).", label: "verified", source_ids: ["s-site-1"] }],
      } as never,
      estimates,
      tools: [],
    }).doc;
    assert.ok(!JSON.stringify(timed).includes("Command Center"), "the client reads our checks, never the Command Center");
    const shelf = b.sections.inefficiencies.items.find((i) => i.finding_ids.includes("h-shelfware"))!;
    assert.match(shelf.why_it_matters.text, /^Tools bought before may not be in use/);
    assert.deepEqual(doc.auditDocIssues(b).filter((i) => i.severity === "block"), []);
  });
  await check("self-test of 2026-10-27: with no website, section 4 holds the problems the client named, in their words, with no figure added", () => {
    const noSite = draft.draftAuditDoc({
      business: { name: "Fixture Heating", type: "local_service", location: "Collingwood" },
      contactName: "Dana Test",
      today: "2026-10-27",
      pack: {
        ...(pack as Record<string, unknown>),
        findings: [
          { id: "f-sales-lost-points", title: "Where customers are lost", statement: "Where customers are lost: calls go to voicemail when the techs are out.", label: "client_reported", source_ids: ["s-client-sales-lost-points"] },
          { id: "f-ops-delays", title: "Where work waits", statement: "Where work waits: quotes are not followed up after they go out.", label: "client_reported", source_ids: ["s-client-ops-delays"] },
        ],
      } as never,
      estimates: [],
      tools: [],
    }).doc;
    const items = noSite.sections.inefficiencies.items;
    assert.deepEqual(items.map((i) => i.finding_ids[0]), ["f-sales-lost-points", "f-ops-delays"], "each problem the client named, once, in order");
    assert.equal(items[0].why_it_matters.text, "Where customers are lost: calls go to voicemail when the techs are out.", "in the client's words");
    for (const i of items) assert.deepEqual(ex.numbersIn(i.consequence.text), [], "the consequence adds no figure");
    assert.ok(doc.validateAuditDoc(noSite).ok);
    // An answer that names no problem adds no inefficiency (Codex review of #757).
    const saidNone = draft.draftAuditDoc({
      business: { name: "Fixture Heating", type: "local_service", location: "Collingwood" },
      contactName: "Dana Test",
      today: "2026-10-27",
      pack: {
        ...(pack as Record<string, unknown>),
        findings: [
          { id: "f-sales-lost-points", title: "Where customers are lost", statement: "Where customers are lost: none.", label: "client_reported", source_ids: ["s-client-sales-lost-points"] },
          { id: "f-ops-delays", title: "Where work waits", statement: "Where work waits: Not really..", label: "client_reported", source_ids: ["s-client-ops-delays"] },
          { id: "f-ops-manual-workflows", title: "Work done by hand", statement: "Work done by hand: No delays.", label: "client_reported", source_ids: ["s-client-ops-manual-workflows"] },
          { id: "f-tech-disconnected", title: "Systems that do not talk to each other", statement: "Systems that do not talk to each other: All our systems are connected.", label: "client_reported", source_ids: ["s-client-tech-disconnected"] },
        ],
      } as never,
      estimates: [],
      tools: [],
    }).doc;
    assert.deepEqual(saidNone.sections.inefficiencies.items, [], "none, not really (with research's extra period), no delays and all connected name no problem");
    // A short answer is still an answer, and a problem CC verified stays (Codex review of #757).
    const shortAndVerified = draft.draftAuditDoc({
      business: { name: "Fixture Heating", type: "local_service", location: "Collingwood" },
      contactName: "Dana Test",
      today: "2026-10-27",
      pack: {
        ...(pack as Record<string, unknown>),
        findings: [
          { id: "f-sales-lost-points", title: "Where customers are lost", statement: "Where customers are lost: Quotes.", label: "client_reported", source_ids: ["s-client-sales-lost-points"] },
          { id: "f-ops-delays", title: "Where work waits", statement: "Where work waits: renewals lapse.", label: "verified", source_ids: ["s-client-ops-delays"] },
        ],
      } as never,
      estimates: [],
      tools: [],
    }).doc;
    assert.deepEqual(shortAndVerified.sections.inefficiencies.items.map((i) => i.finding_ids[0]), ["f-sales-lost-points", "f-ops-delays"]);
    // An answer that names something, even in the negative, is a problem (Codex review of #757).
    const negativeButReal = draft.draftAuditDoc({
      business: { name: "Fixture Heating", type: "local_service", location: "Collingwood" },
      contactName: "Dana Test",
      today: "2026-10-27",
      pack: {
        ...(pack as Record<string, unknown>),
        findings: [
          { id: "f-ops-delays", title: "Where work waits", statement: "Where work waits: No follow-up after quotes.", label: "client_reported", source_ids: ["s-client-ops-delays"] },
          { id: "f-tech-disconnected", title: "Systems that do not talk to each other", statement: "Systems that do not talk to each other: None of our tools talk to each other.", label: "verified", source_ids: ["s-client-tech-disconnected"] },
          { id: "f-ops-manual-workflows", title: "Work done by hand", statement: "Work done by hand: Our CRM needs to be integrated with QuickBooks.", label: "client_reported", source_ids: ["s-client-ops-manual-workflows"] },
        ],
      } as never,
      estimates: [],
      tools: [],
    }).doc;
    assert.equal(negativeButReal.sections.inefficiencies.items.length, 3);
  });
  await check("review of phase 4: a step never comes before what it depends on", () => {
    const base = { title: "x", what_it_does: "x", problem: "x", how_it_works: "x", integrations: [], expected_improvement: { text: "x", cites: [] }, finding_ids: [], estimate_ids: [], sku: "s", urgency: "" };
    const r = opps.planRoadmap([
      { ...base, id: "admin-automation", title: "Automate admin", impact: "high", effort: "low" },
      { ...base, id: "connect-systems", title: "Connect your tools", impact: "medium", effort: "high" },
    ] as never);
    const where = (id: string) => (["now", "next", "later"] as const).find((k) => r[k].some((x) => x.opportunity_id === id));
    assert.equal(where("connect-systems"), "later");
    assert.equal(where("admin-automation"), "later", "it waits for its dependency");
    assert.deepEqual(r.later.map((x) => x.opportunity_id), ["connect-systems", "admin-automation"]);
    assert.ok(r.now.length === 0 || !r.now.some((x) => x.dependencies.length));
  });

  console.log("drafting after research, on the database");
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of ["bravo__186_os_approvals.sql", "bravo__206_tool_jobs.sql", "bravo__240_meet_local_copies.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql", "bravo__241_ai_audit_briefs.sql", "bravo__243_ai_audit_research.sql"]) await apply(db, f);
  const store = await import("../lib/ai-audit/store");
  const lifecycle = await import("../lib/ai-audit/lifecycle");
  const versions = await import("../lib/ai-audit/versions");
  const tr = await import("../lib/ai-audit/transcript");
  const transcripts = await import("../lib/ai-audit/transcripts");
  const authorize = await import("../lib/ai-audit/authorize");
  const execute = await import("../lib/os/approvals/execute");
  const executors = await import("../lib/os/approvals/executors");
  const research = await import("../lib/ai-audit/research");
  const drafting = await import("../lib/ai-audit/drafting");
  const runner = await import("../lib/tools/runner-handlers");
  const tick = await import("../lib/ai-audit/tick");
  const route = await import("../app/api/ai-audit/[engagementId]/route");
  const cc = { type: "user" as const, id: USERS.cc.id };
  let clock = 0;
  const deps = {
    site: { fetch: fakeWeb(WEB) as never, clock: () => (clock += 10) },
    pagespeed: { fetch: (async () => new Response(JSON.stringify(LIGHTHOUSE), { status: 200, headers: { "content-type": "application/json" } })) as never, key: null },
    alert: async () => undefined,
  };
  const runnerDeps = (now: Date) => ({ db, env: { TOOLS_RUNNER_SECRET_MAC: MAC_SECRET }, now, storage: null, aiAuditAlert: async () => undefined });
  const post = (eid: string, body: Record<string, unknown>) => {
    const url = `http://t.test/api/ai-audit/${eid}`;
    const r = new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://t.test" }, body: JSON.stringify(body) }) as Request & { nextUrl: URL };
    Object.defineProperty(r, "nextUrl", { value: new URL(url) });
    return route.POST(r as never, { params: Promise.resolve({ engagementId: eid }) });
  };
  let leadN = 0;
  const authorized = async (name: string, engine: "mac_claude" | "cloud_workspace" | "none" = "mac_claude", extra: Array<[string, unknown]> = []) => {
    leadN += 1;
    const lead = `7d000000-0000-4000-8000-0000000000${String(leadN).padStart(2, "0")}`;
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [lead, OASIS, JSON.stringify({ stage: "qualified", company: `[TEST] ${name}`, name: "Dana Smith", email: `owner+d${leadN}@fixture.test`, website: "https://fixture-plumbing.ca", city: "Calgary" })],
    });
    const o = await store.openEngagement(db, { tenantId: OASIS, leadId: lead, actor: cc, now: NOW(), isFixture: true });
    assert.ok(o.ok);
    const eid = o.ok ? o.engagement.id : "";
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "call_scheduled", actor: cc, now: NOW() })).ok);
    const parsed = tr.parseTranscriptText("Dana: We miss about 10 calls a week.");
    assert.ok(parsed.ok);
    assert.ok((await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: eid, parsed: parsed.ok ? parsed.value : (null as never), source: "paste", consent: { recording: true, ai: true, basis: "owner_attested", by: USERS.cc.id }, actor: cc, now: NOW() })).ok);
    const f = (key: string, value: unknown) => versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: key, value, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    await f("sales.missed_calls_per_week", 10);
    await f("sales.close_rate_pct", 30);
    await f("sales.avg_job_value", 500);
    await f("consent.recording", true);
    await f("consent.ai_processing", true);
    for (const [key, value] of extra) await f(key, value);
    const card = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine });
    assert.ok(card.ok, !card.ok ? card.error : "");
    await db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", args: [USERS.cc.id, new Date().toISOString(), card.ok ? card.approvalId : ""] });
    await execute.executeApproval(db, { tenantId: OASIS, approvalId: card.ok ? card.approvalId : "", approver: { userId: USERS.cc.id, email: USERS.cc.email } }, executors.defaultExecutorDeps() as never);
    assert.equal((await store.getEngagement(db, OASIS, eid))!.stage, "generating");
    return eid;
  };
  const answerSearch = async () => {
    const res = await runner.handleToolsClaim(macRequest("claim", { label: "CC's Mac", version: "1.0.0", tools: ["ai_audit_search"] }, NOW()), runnerDeps(NOW()) as never);
    const job = ((await res.json()) as { job: { job_id: string; lease_id: string } | null }).job;
    if (!job) return false;
    await runner.handleToolsComplete(macRequest("complete", { job_id: job.job_id, lease_id: job.lease_id, tool_key: "ai_audit_search", text: JSON.stringify({ results: [] }) }, NOW()), runnerDeps(NOW()) as never);
    return true;
  };

  await check("before research finishes there is nothing to draft from, and only the owner presses it", async () => {
    const eid = await authorized("Early Draft Co");
    assert.deepEqual(await drafting.draftAuditFromResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() }), { ok: false, error: "no_research" });
    await login(USERS.admin);
    assert.equal((await post(eid, { action: "draft_audit" })).status, 403);
    await login(null);
    // Out of the way of the next check's ticks.
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "cancelled", actor: cc, now: NOW() })).ok);
  });
  await check("the tick drafts the audit and the proposal once, when the first research run finishes", async () => {
    const eid = await authorized("Tick Draft Co");
    const tickDeps = { payment: { alert: async () => undefined } as never, onboarding: {} as never, site: deps.site, research: deps };
    let drafted = 0;
    for (let i = 0; i < 10 && !drafted; i++) {
      const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps });
      assert.deepEqual(rep.errors, [], JSON.stringify(rep.errors));
      drafted += rep.auditsDrafted;
      await answerSearch();
    }
    assert.equal(drafted, 1, "drafted once");
    const e = (await store.getEngagement(db, OASIS, eid))!;
    const audit = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    assert.equal(audit.status, "draft");
    assert.ok(audit.doc && audit.doc.sections.opportunities.items.some((o) => o.id === "answer-missed-calls"));
    assert.deepEqual(doc.auditDocIssues(audit.doc!).filter((x) => x.severity === "block"), []);
    const prop = (await versions.getProposalVersion(db, OASIS, e.current_proposal_version_id!))!;
    assert.ok(prop.content && prop.content.lines.length >= 1 && prop.content.lines.every((l) => l.kind === "needs_owner_price"), "no confirmed catalogue item: every line waits for CC's price");
    const again = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps });
    assert.equal(again.auditsDrafted, 0, "a finished run is drafted from once");
  });
  await check("after the drafts, the Mac writes the opening: the prompt holds the draft's facts, and only checked sentences replace the draft's", async () => {
    const eid = (await db.execute("SELECT id FROM ai_audit_engagements WHERE business_name LIKE '%Tick Draft Co%' LIMIT 1")).rows[0].id as string;
    const writing = await import("../lib/ai-audit/writing");
    const started = await writing.startWriting(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() });
    assert.ok(started.ok && started.runsOn === "mac" && !started.created, "the tick started it already, and a second start hands it back");
    const res = await runner.handleToolsClaim(macRequest("claim", { label: "CC's Mac", version: "1.0.0", tools: ["ai_audit_model"] }, NOW()), runnerDeps(NOW()) as never);
    const job = ((await res.json()) as { job: { job_id: string; lease_id: string; input: Record<string, unknown> } | null }).job;
    assert.ok(job && job.input.purpose === "write", JSON.stringify(job));
    assert.match(String(job!.input.prompt), /f-sales-missed-calls-per-week/);
    assert.ok(!String(job!.input.prompt).includes("We miss about 10 calls a week"), "the call's own words never reach the writer");
    const now0 = (await store.getEngagement(db, OASIS, eid))!;
    const told = (await versions.getAuditVersion(db, OASIS, now0.current_audit_version_id!))!.doc!.sections.current_assessment.paragraphs[0];
    assert.match(told.text, /^What you told us: /);
    // The same facts, in the same order, said as one sentence: every word and figure is the paragraph's own.
    const rewrite = told.text.replace("What you told us: ", "You told us that ").replace(/; and /, ", and that ").replace(/; /g, ", that ");
    const text = JSON.stringify({
      executive_overview: [{ sentences: [{ text: "We will double your revenue.", cites: [] }] }],
      current_assessment: [{ sentences: [{ text: rewrite, cites: told.cites }] }],
      key_findings_intro: [{ sentences: [{ text: "Each finding carries one label: Verified fact, Client-reported, or Hypothesis.", cites: [] }] }],
    });
    const done = await runner.handleToolsComplete(macRequest("complete", { job_id: job!.job_id, lease_id: job!.lease_id, tool_key: "ai_audit_model", text }, NOW()), runnerDeps(NOW()) as never);
    assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
    const e = (await store.getEngagement(db, OASIS, eid))!;
    const audit = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    assert.match(audit.doc!.sections.executive_overview.paragraphs[0].text, /^This audit looks at how/, "the overview keeps its code paragraph");
    assert.equal(audit.doc!.sections.current_assessment.paragraphs[0].text, rewrite);
    assert.equal(audit.doc!.sections.key_findings.intro?.text, "Each finding carries one label: Verified fact, Client-reported, or Hypothesis.");
    assert.deepEqual(doc.auditDocIssues(audit.doc!).filter((x) => x.severity === "block"), []);
    const step = await writing.latestWriteStep(db, OASIS, eid);
    assert.ok(step && step.status === "done" && step.written);
    assert.deepEqual(step!.withheld.map((w) => w.reason), ["it promises a result"]);
    const stored = String((await db.execute({ sql: "SELECT result_json FROM tool_jobs WHERE id = ?", args: [job!.job_id] })).rows[0].result_json);
    assert.ok(!stored.includes("double your revenue"), "the job never keeps the model's text");
  });
  await check("CC's own edit wins: a pass that answers after it changes nothing", async () => {
    const eid = (await db.execute("SELECT id FROM ai_audit_engagements WHERE business_name LIKE '%Tick Draft Co%' LIMIT 1")).rows[0].id as string;
    await login(USERS.cc);
    const press = await post(eid, { action: "write_prose" });
    assert.equal(press.status, 200, JSON.stringify(await press.clone().json()));
    await login(null);
    const res = await runner.handleToolsClaim(macRequest("claim", { label: "CC's Mac", version: "1.0.0", tools: ["ai_audit_model"] }, NOW()), runnerDeps(NOW()) as never);
    const job = ((await res.json()) as { job: { job_id: string; lease_id: string } | null }).job;
    assert.ok(job);
    const e = (await store.getEngagement(db, OASIS, eid))!;
    const audit = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    const mine = { ...audit.doc!, sections: { ...audit.doc!.sections, executive_overview: { paragraphs: [{ text: "Written by CC himself.", cites: [] }] } } };
    assert.ok((await versions.saveAuditDraft(db, { tenantId: OASIS, engagementId: eid, doc: mine, actor: cc, now: NOW(), expectedRowVersion: e.row_version })).ok);
    const text = JSON.stringify({ executive_overview: [{ text: "A model's opening.", cites: [] }] });
    await runner.handleToolsComplete(macRequest("complete", { job_id: job!.job_id, lease_id: job!.lease_id, tool_key: "ai_audit_model", text }, NOW()), runnerDeps(NOW()) as never);
    const after = (await versions.getAuditVersion(db, OASIS, (await store.getEngagement(db, OASIS, eid))!.current_audit_version_id!))!;
    assert.equal(after.doc!.sections.executive_overview.paragraphs[0].text, "Written by CC himself.");
    const writing = await import("../lib/ai-audit/writing");
    const step = await writing.latestWriteStep(db, OASIS, eid);
    assert.deepEqual([step?.status, step?.error], ["cancelled", "draft_changed"]);
    await login(USERS.admin);
    assert.equal((await post(eid, { action: "write_prose" })).status, 403, "only the owner starts a pass");
    await login(null);
  });
  await check("on the cloud engine the tick writes the opening through the metered model, once", async () => {
    const eid = await authorized("Cloud Prose Co", "cloud_workspace");
    const calls: Array<{ surface: string }> = [];
    const model = async (call: { surface: string }) => {
      calls.push(call);
      return { ok: true as const, text: JSON.stringify({ key_findings_intro: [{ sentences: [{ text: "Each finding carries one label: Verified fact, Client-reported, or Hypothesis.", cites: [] }] }] }) };
    };
    const tickDeps = { payment: { alert: async () => undefined } as never, onboarding: {} as never, site: deps.site, research: deps, writing: { model: model as never, alert: async () => undefined } };
    let run = 0;
    for (let i = 0; i < 12 && !run; i++) {
      const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps });
      assert.deepEqual(rep.errors, [], JSON.stringify(rep.errors));
      run += rep.writingRun;
      await answerSearch();
    }
    assert.equal(run, 1);
    assert.deepEqual(calls.map((c) => c.surface), ["ai_audit.write"]);
    const e = (await store.getEngagement(db, OASIS, eid))!;
    const audit = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    assert.equal(audit.doc!.sections.key_findings.intro?.text, "Each finding carries one label: Verified fact, Client-reported, or Hypothesis.");
  });
  await check("with no AI engine authorized, nothing writes the opening and CC's press says why", async () => {
    const eid = await authorized("No Engine Co", "none");
    const tickDeps = { payment: { alert: async () => undefined } as never, onboarding: {} as never, site: deps.site, research: deps, writing: { model: (async () => assert.fail("no model call")) as never, alert: async () => undefined } };
    let drafted = 0;
    for (let i = 0; i < 12 && !drafted; i++) {
      const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps });
      assert.deepEqual(rep.errors, [], JSON.stringify(rep.errors));
      assert.equal(rep.writingStarted, 0);
      drafted += rep.auditsDrafted;
      await answerSearch();
    }
    assert.equal(drafted, 1);
    await login(USERS.cc);
    const res = await post(eid, { action: "write_prose" });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, error: "no_ai_engine" });
    await login(null);
  });
  await check("review of phase 4: CC's edit before the Mac claims ends the pass, and his press starts a fresh one; a failing finish never strands it", async () => {
    const eid = (await db.execute("SELECT id FROM ai_audit_engagements WHERE business_name LIKE '%Tick Draft Co%' LIMIT 1")).rows[0].id as string;
    const writing = await import("../lib/ai-audit/writing");
    await login(USERS.cc);
    assert.equal((await post(eid, { action: "write_prose" })).status, 200);
    await login(null);
    const first = (await writing.latestWriteStep(db, OASIS, eid))!;
    assert.ok(["waiting_runner"].includes(first.status));
    let e = (await store.getEngagement(db, OASIS, eid))!;
    const audit = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    const edited = { ...audit.doc!, sections: { ...audit.doc!.sections, executive_overview: { paragraphs: [{ text: "CC's own words, before the Mac woke up.", cites: [] }] } } };
    assert.ok((await versions.saveAuditDraft(db, { tenantId: OASIS, engagementId: eid, doc: edited, actor: cc, now: NOW(), expectedRowVersion: e.row_version })).ok);
    const res = await runner.handleToolsClaim(macRequest("claim", { label: "CC's Mac", version: "1.0.0", tools: ["ai_audit_model"] }, NOW()), runnerDeps(NOW()) as never);
    assert.equal(((await res.json()) as { job: unknown }).job, null, "the claim hands out nothing for an old draft");
    const ended = (await writing.latestWriteStep(db, OASIS, eid))!;
    assert.deepEqual([ended.status, ended.error], ["cancelled", "draft_changed"]);
    await login(USERS.cc);
    const again = await post(eid, { action: "write_prose" });
    assert.equal(((await again.json()) as { created?: boolean }).created, true, "a fresh pass, not the dead one");
    await login(null);
    // A finish that throws after the job closed: the runner still gets its answer, and the pass is not left running.
    const claim = await runner.handleToolsClaim(macRequest("claim", { label: "CC's Mac", version: "1.0.0", tools: ["ai_audit_model"] }, NOW()), runnerDeps(NOW()) as never);
    const job = ((await claim.json()) as { job: { job_id: string; lease_id: string } | null }).job;
    assert.ok(job);
    const broken = { ...runnerDeps(NOW()), aiAuditAlert: async () => { throw new Error("alerts are down"); } };
    const text = JSON.stringify({ key_findings_intro: { text: "Each finding is labelled, so you can see where it came from.", cites: [] } });
    const done = await runner.handleToolsComplete(macRequest("complete", { job_id: job!.job_id, lease_id: job!.lease_id, tool_key: "ai_audit_model", text }, NOW()), broken as never);
    assert.equal(done.status, 200);
    const last = (await writing.latestWriteStep(db, OASIS, eid))!;
    assert.ok(!["queued", "running", "waiting_runner"].includes(last.status), last.status);
    e = (await store.getEngagement(db, OASIS, eid))!;
  });
  await check("review of phase 4: two ticks at once make one metered call for a cloud pass", async () => {
    const eid = (await db.execute("SELECT id FROM ai_audit_engagements WHERE business_name LIKE '%Cloud Prose Co%' LIMIT 1")).rows[0].id as string;
    const writing = await import("../lib/ai-audit/writing");
    await login(USERS.cc);
    assert.equal((await post(eid, { action: "write_prose" })).status, 200);
    await login(null);
    const step = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE engagement_id = ? AND step_key = 'write' AND status = 'queued' LIMIT 1", args: [eid] })).rows[0].id as string;
    let calls = 0;
    const model = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true as const, text: JSON.stringify({ executive_overview: [{ text: "Cloud Prose Co misses 10 calls a week.", cites: ["f-sales-missed-calls-per-week"] }] }) };
    };
    const deps2 = { model: model as never, alert: async () => undefined };
    const both = await Promise.all([writing.advanceCloudWriting(db, { tenantId: OASIS, stepId: step, now: NOW(), deps: deps2 }), writing.advanceCloudWriting(db, { tenantId: OASIS, stepId: step, now: NOW(), deps: deps2 })]);
    assert.equal(calls, 1, JSON.stringify(both));
    assert.deepEqual([...both].sort(), ["finished", "idle"]);
  });
  await check("review of phase 4: a business name with a line break still drafts a proposal that reads back", async () => {
    const eid = await authorized("Broken\nName Co");
    const tickDeps = { payment: { alert: async () => undefined } as never, onboarding: {} as never, site: deps.site, research: deps, writing: { model: (async () => ({ ok: false as const, code: "ai_account_missing" })) as never, alert: async () => undefined } };
    for (let i = 0; i < 12; i++) {
      const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps });
      assert.deepEqual(rep.errors, [], JSON.stringify(rep.errors));
      await answerSearch();
      if ((await store.getEngagement(db, OASIS, eid))!.current_proposal_version_id) break;
    }
    const e = (await store.getEngagement(db, OASIS, eid))!;
    const prop = (await versions.getProposalVersion(db, OASIS, e.current_proposal_version_id!))!;
    assert.ok(prop.content, "it reads back");
    assert.ok(!/[\r\n]/.test(prop.content!.delivery_email.subject));
  });
  await check("review of phase 4, third round: a Mac pass whose model call failed is dead: CC's press starts a fresh one, and the tick calls it off with why", async () => {
    const eid = (await db.execute("SELECT id FROM ai_audit_engagements WHERE business_name LIKE '%Tick Draft Co%' LIMIT 1")).rows[0].id as string;
    const writing = await import("../lib/ai-audit/writing");
    await login(USERS.cc);
    assert.equal((await post(eid, { action: "write_prose" })).status, 200);
    await login(null);
    const first = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE engagement_id = ? AND step_key = 'write' AND status = 'waiting_runner' LIMIT 1", args: [eid] })).rows[0].id as string;
    await db.execute({ sql: "UPDATE tool_jobs SET status = 'failed', error_code = 'model_failed' WHERE tool_key = 'ai_audit_model' AND json_extract(input_json, '$.step_id') = ?", args: [first] });
    await login(USERS.cc);
    const again = await post(eid, { action: "write_prose" });
    assert.equal(((await again.json()) as { created?: boolean }).created, true, "a fresh pass, not the dead one");
    await login(null);
    assert.deepEqual([String((await db.execute({ sql: "SELECT status, error_code FROM ai_audit_steps WHERE id = ?", args: [first] })).rows[0].status)], ["failed"]);
    // The tick finds a dead pass by itself too.
    const second = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE engagement_id = ? AND step_key = 'write' AND status = 'waiting_runner' LIMIT 1", args: [eid] })).rows[0].id as string;
    await db.execute({ sql: "UPDATE tool_jobs SET status = 'failed', error_code = 'attempts_exhausted' WHERE tool_key = 'ai_audit_model' AND json_extract(input_json, '$.step_id') = ?", args: [second] });
    const due = await writing.dueWriting(db, OASIS, NOW());
    assert.ok(due.stale.includes(second));
    const told: Array<Record<string, unknown>> = [];
    await writing.callOffStaleWriting(db, OASIS, second, NOW(), async (a) => void told.push(a as Record<string, unknown>));
    assert.equal(String((await db.execute({ sql: "SELECT status FROM ai_audit_steps WHERE id = ?", args: [second] })).rows[0].status), "failed");
    assert.match(String(told[0]?.body), /model call failed/);
  });
  await check("review of phase 4, third round: a cloud pass that cannot finish is counted and backed off, not paid for on every tick", async () => {
    const eid = (await db.execute("SELECT id FROM ai_audit_engagements WHERE business_name LIKE '%Cloud Prose Co%' LIMIT 1")).rows[0].id as string;
    const writing = await import("../lib/ai-audit/writing");
    await login(USERS.cc);
    assert.equal((await post(eid, { action: "write_prose" })).status, 200);
    await login(null);
    const step = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE engagement_id = ? AND step_key = 'write' AND status = 'queued' LIMIT 1", args: [eid] })).rows[0].id as string;
    let calls = 0;
    const model = async () => {
      calls += 1;
      return { ok: true as const, text: JSON.stringify({ key_findings_intro: [{ sentences: [{ text: "Each finding carries one label: Verified fact, Client-reported, or Hypothesis.", cites: [] }] }] }) };
    };
    // The save after the check fails (a store error): the pass must not stay running for the next tick to pay for again.
    await db.execute("CREATE TRIGGER fail_prose_save BEFORE INSERT ON ai_audit_events WHEN NEW.event = 'audit_draft_saved' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    const out = await writing.advanceCloudWriting(db, { tenantId: OASIS, stepId: step, now: NOW(), deps: { model: model as never, alert: async () => undefined } });
    await db.execute("DROP TRIGGER fail_prose_save");
    assert.equal(out, "retry");
    const row = (await db.execute({ sql: "SELECT status, attempts, next_attempt_at FROM ai_audit_steps WHERE id = ?", args: [step] })).rows[0];
    assert.deepEqual([String(row.status), Number(row.attempts)], ["queued", 1]);
    assert.ok(Date.parse(String(row.next_attempt_at)) > Date.now());
    assert.equal(await writing.advanceCloudWriting(db, { tenantId: OASIS, stepId: step, now: NOW(), deps: { model: model as never, alert: async () => undefined } }), "idle", "it waits out its back-off");
    assert.equal(calls, 1);
  });
  await check("CC's press drafts again only when told to replace, and the proposal follows the audit's opportunities", async () => {
    const eid = (await db.execute("SELECT id FROM ai_audit_engagements WHERE business_name LIKE '%Tick Draft Co%' LIMIT 1")).rows[0].id as string;
    assert.deepEqual(await drafting.draftAuditFromResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() }), { ok: false, error: "draft_exists" });
    await login(USERS.cc);
    const res = await post(eid, { action: "draft_audit", replace: true });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.deepEqual(((await res.json()) as { blocking?: number }).blocking, 0);
    assert.equal((await post(eid, { action: "draft_proposal" })).status, 409, "a proposal draft is there already");
    assert.equal((await post(eid, { action: "draft_proposal", replace: true })).status, 200);
    await login(null);
    const events = await db.execute({ sql: "SELECT event FROM ai_audit_events WHERE engagement_id = ? AND event IN ('audit_drafted', 'proposal_drafted') ORDER BY rowid", args: [eid] });
    assert.deepEqual(events.rows.map((r) => String(r.event)), ["audit_drafted", "proposal_drafted", "audit_drafted", "proposal_drafted"]);
  });
  await check("review of #759: the saved proposal drafts the setter tier the client's lead sources call for", async () => {
    const eid = await authorized("Many Sources Co", "mac_claude", [["sales.lead_sources", [{ source: "Google", "per month": 40 }, { source: "Referrals", "per month": 10 }]]]);
    const r = await research.startResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() });
    assert.ok(r.ok);
    const stepId = r.ok ? r.stepId : "";
    let state = "";
    for (let i = 0; i < 12 && state !== "finished"; i++) {
      state = await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps });
      await answerSearch();
    }
    assert.equal(state, "finished");
    assert.ok((await drafting.draftAuditFromResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() })).ok);
    const drafted = await drafting.draftProposalFromAudit(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() });
    assert.ok(drafted.ok, JSON.stringify(drafted));
    const e = (await store.getEngagement(db, OASIS, eid))!;
    const prop = (await versions.getProposalVersion(db, OASIS, e.current_proposal_version_id!))!;
    const skus = prop.content!.lines.map((l) => (l.kind === "catalogue" ? l.sku : l.kind === "needs_owner_price" ? (l.suggested_sku ?? "") : ""));
    assert.ok(skus.includes("checkout-sales-setter-scale") && !skus.includes("checkout-sales-setter-launch"), JSON.stringify(skus));
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "cancelled", actor: cc, now: NOW() })).ok);
  });
  await check("a run that ends without the authorization drafts nothing", async () => {
    const eid = await authorized("Voided Draft Co");
    const r = await research.startResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() });
    assert.ok(r.ok);
    const t = (await db.execute({ sql: "SELECT id FROM ai_audit_transcripts WHERE engagement_id = ? LIMIT 1", args: [eid] })).rows[0].id as string;
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: t, actor: cc, now: NOW() }), { ok: true });
    assert.deepEqual(await drafting.draftAuditFromResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() }), { ok: false, error: "not_authorized" });
  });

  await check("every audit screen draws with its real data, for the owner and an admin, and says what comes next", async () => {
    const { checkAuditScreens } = await import("./_ai-audit-screens");
    const drawn = await checkAuditScreens(db, OASIS, USERS.cc.id);
    assert.ok(drawn > 0);
  });

  finish("ai-audit-drafting");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
