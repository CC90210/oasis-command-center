/**
 * ai-audit-drafting.test.ts — phase 4a of the Free AI Audit: the first drafts
 * of the audit and its proposal, built by code from the stored research, on a
 * real libSQL file with the real migrations (bravo__186, 206, 237, 238, 239,
 * 241, 243).
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
    assert.deepEqual(d.gaps.map((g) => g.topic), ["Cost of admin time saved"]);
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
  });


  console.log("the opening, written by a model and checked");
  const prose = await import("../lib/ai-audit/prose");
  await check("a written sentence stays only on its citations: invented figures, promises, prices and names are held back", () => {
    const answer = JSON.stringify({
      executive_overview: [
        { text: "Fixture Plumbing misses 10 calls a week, and answering them within minutes could win back $1,300 to $3,250 per month. We guarantee it will double your bookings.", cites: ["f-sales-missed-calls-per-week", "est-missed-calls", "not-an-id"] },
        { text: "Your close rate is 45%.", cites: ["f-sales-close-rate-pct"] },
      ],
      current_assessment: [{ text: "You use Jobber for scheduling, and Google PageSpeed scores your home page 42 out of 100 for speed on a phone.", cites: ["f-ps-performance"] }],
      key_findings_intro: { text: "Each finding is labelled, so you can see where it came from.", cites: [] },
      impact_intro: { text: "HubSpot says most shops win back 80 percent of missed calls.", cites: [] },
    });
    const r = prose.checkProse(answer, d);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.value.parts.executive_overview?.map((x) => x.text), ["Fixture Plumbing misses 10 calls a week, and answering them within minutes could win back $1,300 to $3,250 per month."]);
    assert.deepEqual(r.value.parts.executive_overview?.[0].cites, ["f-sales-missed-calls-per-week", "est-missed-calls"], "an id the draft does not hold is dropped");
    assert.ok(r.value.parts.current_assessment?.length === 1, JSON.stringify(r.value.withheld));
    assert.equal(r.value.parts.impact_intro, undefined, "a sentence naming a company the facts never name, with a figure nothing states, is held back");
    const reasons = r.value.withheld.map((w) => `${w.part}: ${w.reason}`);
    assert.ok(reasons.some((x) => /executive_overview: it promises a result/.test(x)), reasons.join(" | "));
    assert.ok(reasons.some((x) => /it states 45, which nothing it cites states/.test(x)), reasons.join(" | "));
    assert.ok(reasons.some((x) => /^impact_intro: /.test(x)), reasons.join(" | "));
    const next = prose.applyProse(d, r.value);
    assert.equal(next.sections.executive_overview.paragraphs.length, 1);
    assert.deepEqual(next.sections.impact.intro, d.sections.impact.intro, "a part with nothing kept keeps the draft's wording");
    assert.deepEqual(doc.auditDocIssues(next).filter((i) => i.severity === "block"), []);
    assert.deepEqual(prose.checkProse("not json at all", d), { ok: false, error: "unreadable" });
    const p = prose.prosePrompt(d);
    assert.match(p.prompt, /UNTRUSTED_INPUT_BEGIN[\s\S]*est-missed-calls/);
    assert.match(p.system, /Never state a figure, a price/);
  });

  await check("a figure keeps its period, is written in digits, and no general rule or new time frame slips through", () => {
    const one = (text: string, cites: string[]) => {
      const r = prose.checkProse(JSON.stringify({ executive_overview: [{ text, cites }] }), d);
      assert.ok(r.ok);
      return r.ok ? (r.value.withheld[0]?.reason ?? "kept") : "";
    };
    const calls = ["f-sales-missed-calls-per-week"];
    assert.equal(one("You miss 10 calls a month.", calls), "it states 10 a month; what it cites gives 10 a week");
    assert.equal(one("Missed calls cost you 10 jobs every year.", calls), "it states 10 a year; what it cites gives 10 a week");
    assert.equal(one("Each week about 10 calls go unanswered.", calls), "kept");
    assert.equal(one("Fixture Plumbing misses 10 calls a week, and each one can be answered within a minute.", calls), "kept");
    assert.match(one("You miss ten calls a week.", calls), /^it writes a figure in a form the check cannot match/);
    assert.match(one("Half of your calls go unanswered.", calls), /^it writes a figure in a form the check cannot match/);
    assert.match(one("You miss \u0661\u0660 calls a week.", calls), /^it writes a figure in a form the check cannot match/);
    assert.equal(one("Answering them could win back $1,300\u2013$3,250 a month.", ["est-missed-calls"]), "kept");
    assert.equal(one("Answering them could win back $1,300 to $3,250 a week.", ["est-missed-calls"]), "it states 1,300 a week; what it cites gives 1,300 a month");
    assert.equal(one("Admin takes 8 hours a week, and automation could take 1.5 hours to 3 hours of it each week.", ["f-ops-admin-hours-per-week", "est-admin-hours"]), "kept");
    assert.equal(one("PageSpeed scores your home page 42 out of 100 on a phone.", ["f-ps-performance"]), "kept");
    assert.equal(one("It answers calls 24/7.", []), "it states a figure without citing where it comes from");
    assert.equal(one("Most owners lose work this way.", []), "it states a general rule the audit's facts do not");
    assert.equal(one("Studies show that callers rarely leave a message.", []), "it states a general rule the audit's facts do not");
    assert.equal(one("We can set this up in a week.", []), "it claims something the audit's facts do not state");
    assert.equal(one("Fixture Plumbing books its jobs in ServiceTitan.", ["f-tech-tools"]), "it claims something the audit's facts do not state");
    assert.equal(one("This would pay for itself.", []), "it promises a result");
    assert.equal(one("The most valuable change is answering missed calls.", []), "kept");
    assert.equal(one("You miss 10 calls a week at a 30% close rate.", [...calls, "f-sales-close-rate-pct"]), "kept", "a period another figure took is not this one's");
    assert.equal(one("Each month, $1,300 to $3,250 could come back.", ["est-missed-calls"]), "kept");
    const digits = { ...d, business: { ...d.business, name: "24 Hour Plumbing" } };
    const named = prose.checkProse(JSON.stringify({ executive_overview: [{ text: "24 Hour Plumbing misses 10 calls a week.", cites: calls }] }), digits);
    assert.ok(named.ok && named.value.parts.executive_overview?.length === 1, JSON.stringify(named));
    const sourced = prose.checkProse(JSON.stringify({ current_assessment: [{ text: "We read your website and spoke with you.", cites: ["src-call", "s-not-here"] }] }), d);
    assert.ok(sourced.ok && sourced.value.parts.current_assessment?.[0].cites.join() === "src-call", "a source id the draft holds is kept as a cite");
  });

  console.log("drafting after research, on the database");
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of ["bravo__186_os_approvals.sql", "bravo__206_tool_jobs.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql", "bravo__241_ai_audit_briefs.sql", "bravo__243_ai_audit_research.sql"]) await apply(db, f);
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
  const authorized = async (name: string, engine: "mac_claude" | "cloud_workspace" | "none" = "mac_claude") => {
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
    assert.match(String(job!.input.prompt), /est-missed-calls/);
    assert.ok(!String(job!.input.prompt).includes("We miss about 10 calls a week"), "the call's own words never reach the writer");
    const text = JSON.stringify({
      executive_overview: [{ text: "Tick Draft Co misses 10 calls a week, and each one can be answered within a minute. We will double your revenue.", cites: ["f-sales-missed-calls-per-week"] }],
      current_assessment: [],
      key_findings_intro: { text: "Each finding is labelled, so you can see where it came from.", cites: [] },
      impact_intro: { text: "The estimates are ranges from your own figures.", cites: [] },
    });
    const done = await runner.handleToolsComplete(macRequest("complete", { job_id: job!.job_id, lease_id: job!.lease_id, tool_key: "ai_audit_model", text }, NOW()), runnerDeps(NOW()) as never);
    assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
    const e = (await store.getEngagement(db, OASIS, eid))!;
    const audit = (await versions.getAuditVersion(db, OASIS, e.current_audit_version_id!))!;
    assert.equal(audit.doc!.sections.executive_overview.paragraphs[0].text, "Tick Draft Co misses 10 calls a week, and each one can be answered within a minute.");
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
      return { ok: true as const, text: JSON.stringify({ executive_overview: [{ text: "Cloud Prose Co misses 10 calls a week.", cites: ["f-sales-missed-calls-per-week"] }] }) };
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
    assert.equal(audit.doc!.sections.executive_overview.paragraphs[0].text, "Cloud Prose Co misses 10 calls a week.");
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
  await check("a run that ends without the authorization drafts nothing", async () => {
    const eid = await authorized("Voided Draft Co");
    const r = await research.startResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() });
    assert.ok(r.ok);
    const t = (await db.execute({ sql: "SELECT id FROM ai_audit_transcripts WHERE engagement_id = ? LIMIT 1", args: [eid] })).rows[0].id as string;
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: t, actor: cc, now: NOW() }), { ok: true });
    assert.deepEqual(await drafting.draftAuditFromResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() }), { ok: false, error: "not_authorized" });
  });

  finish("ai-audit-drafting");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
