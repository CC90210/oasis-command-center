/**
 * ai-audit-research.test.ts — phase 3 of the Free AI Audit: the research behind
 * an audit, after Gate 1, on a real libSQL file with the real migrations
 * (bravo__186, 206, 237, 238, 239, 241, 243).
 *
 * Pins:
 *   - the evidence rules: a Verified fact needs our own measurement, a stored
 *     page that states it (every figure and most words), or CC's note; a
 *     benchmark needs a reliable, recent source; a figure never stands as a
 *     hypothesis; nothing is ever upgraded;
 *   - the impact calculator gives ranges from the client's own figures and the
 *     stated assumptions, names the figures it lacks, and refuses bad ranges;
 *   - the web search: public facts only in the prompt; the answer is checked
 *     (public addresses, known kinds, at most twelve); pages behind a login
 *     are gaps;
 *   - a run: only after Gate 1, one phase per call; the Mac is handed the
 *     prompt at claim time and the job keeps only the checked list; each page
 *     is read by the Command Center under its own robots.txt; the stored run
 *     is frozen and holds no word of the call; a voided authorization stops
 *     it and the Mac is handed nothing; a search no Mac runs is skipped with
 *     a gap;
 *   - the tick starts and moves runs; the page shows the run and the
 *     estimates with CC's ranges; only the owner presses Research again or
 *     changes the ranges.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-research.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { OASIS, USERS, check, finish, login, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];

const MAC_SECRET = "mac-runner-research-test-secret-0123456789abcdef";
const NOW = () => new Date();

/** A request signed as the Mac's runner (lib/tools/runner-auth.ts): HMAC-SHA256 over "<ts>.<body>". */
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

type Route = { status?: number; body?: string; type?: string; location?: string };
/** The web as these tests see it: listed addresses answer, others on a known site are 404s, anything else fails. */
function fakeWeb(routes: Record<string, Route>) {
  const seen: string[] = [];
  const origins = new Set(Object.keys(routes).map((u) => new URL(u).origin));
  const fetch = async (url: string) => {
    seen.push(url);
    const r = routes[url];
    if (!r) {
      if (origins.has(new URL(url).origin)) return new Response("<html><title>Not found</title></html>", { status: 404, headers: { "content-type": "text/html" } });
      throw new TypeError("fetch failed");
    }
    const headers = new Headers({ "content-type": r.type ?? "text/html; charset=utf-8" });
    if (r.location) headers.set("location", r.location);
    return new Response(r.status && r.status >= 300 && r.status < 400 ? null : (r.body ?? ""), { status: r.status ?? 200, headers });
  };
  return { fetch, seen };
}

const HOME = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fixture Plumbing | Calgary plumbers</title><meta name="description" content="Emergency plumbing in Calgary.">
</head><body><header><a href="/">Home</a> <a href="/contact">Contact us</a></header>
<main><h1>Fast, friendly plumbing</h1><p>${"We fix leaks, drains and water heaters across the city. ".repeat(8)}</p>
<a href="tel:+14035550199">Call (403) 555-0199</a></main></body></html>`;
const CONTACT = `<html><head><title>Contact</title></head><body><form action="/send" method="post"><input name="name"><input name="email"><textarea name="message"></textarea><button>Send</button></form></body></html>`;
const LISTING = `<html><head><title>Fixture Plumbing - Calgary - Yelp</title></head><body><h1>Fixture Plumbing</h1><p>Rated 4.8 stars from 120 reviews in Calgary.</p></body></html>`;
const OPEN_ROBOTS = { body: "User-agent: *\nAllow: /\n", type: "text/plain" };
const WEB: Record<string, Route> = {
  "https://fixture-plumbing.ca/": { body: HOME },
  "https://fixture-plumbing.ca/robots.txt": OPEN_ROBOTS,
  "https://fixture-plumbing.ca/contact": { body: CONTACT },
  "http://fixture-plumbing.ca/": { status: 301, location: "https://fixture-plumbing.ca/" },
  "https://www.yelp.ca/robots.txt": OPEN_ROBOTS,
  "https://www.yelp.ca/biz/fixture-plumbing-calgary": { body: LISTING },
  "https://closed-directory.ca/robots.txt": { body: "User-agent: *\nDisallow: /\n", type: "text/plain" },
  "https://closed-directory.ca/page": { body: "<html><body>Listed since 2015.</body></html>" },
};
const LIGHTHOUSE = {
  lighthouseResult: {
    finalDisplayedUrl: "https://fixture-plumbing.ca/",
    lighthouseVersion: "12.0.0",
    categories: { performance: { score: 0.42 }, accessibility: { score: 0.91 }, seo: { score: 0.83 }, "best-practices": { score: 0.75 } },
    audits: {
      "largest-contentful-paint": { numericValue: 5400 },
      "first-contentful-paint": { numericValue: 2100 },
      "total-blocking-time": { numericValue: 320 },
      "cumulative-layout-shift": { numericValue: 0.05 },
      "speed-index": { numericValue: 4800 },
    },
  },
};
const SEARCH_ANSWER = JSON.stringify({
  results: [
    {
      url: "https://www.yelp.ca/biz/fixture-plumbing-calgary",
      title: "Fixture Plumbing - Yelp",
      kind: "review",
      claims: [
        { text: "Rated 4.8 stars from 120 reviews", value: 4.8, unit: "stars" },
        // Not on the page: the model's own number. The evidence rules must drop it.
        { text: "Rated 5 stars by 300 reviewers", value: 5, unit: "stars" },
      ],
    },
    { url: "https://www.instagram.com/fixtureplumbing", title: "Instagram", kind: "social", claims: [] },
    { url: "http://127.0.0.1/admin", title: "Local", kind: "listing", claims: [] },
    { url: "https://closed-directory.ca/page", title: "Closed directory", kind: "listing", claims: [{ text: "Listed since 2015", value: 2015, unit: "years" }] },
    { url: "https://www.yelp.ca/biz/fixture-plumbing-calgary#reviews", title: "The same page again", kind: "review", claims: [] },
  ],
});

async function main() {
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of [
    "bravo__186_os_approvals.sql",
    "bravo__206_tool_jobs.sql",
    "bravo__237_ai_audit_core.sql",
    "bravo__238_ai_audit_delivery.sql",
    "bravo__239_ai_audit_discovery.sql",
    "bravo__241_ai_audit_briefs.sql",
    "bravo__243_ai_audit_research.sql",
  ])
    await apply(db, f);

  const store = await import("../lib/ai-audit/store");
  const lifecycle = await import("../lib/ai-audit/lifecycle");
  const versions = await import("../lib/ai-audit/versions");
  const tr = await import("../lib/ai-audit/transcript");
  const transcripts = await import("../lib/ai-audit/transcripts");
  const authorize = await import("../lib/ai-audit/authorize");
  const execute = await import("../lib/os/approvals/execute");
  const executors = await import("../lib/os/approvals/executors");
  const research = await import("../lib/ai-audit/research");
  const evidence = await import("../lib/ai-audit/evidence");
  const impact = await import("../lib/ai-audit/impact");
  const search = await import("../lib/ai-audit/search");
  const pagespeed = await import("../lib/ai-audit/pagespeed");
  const runner = await import("../lib/tools/runner-handlers");
  const tick = await import("../lib/ai-audit/tick");
  const view = await import("../lib/ai-audit/view");
  const route = await import("../app/api/ai-audit/[engagementId]/route");

  const cc = { type: "user" as const, id: USERS.cc.id };
  const alerts: Array<Record<string, unknown>> = [];
  const runnerDeps = (now: Date) => ({ db, env: { TOOLS_RUNNER_SECRET_MAC: MAC_SECRET }, now, storage: null, aiAuditAlert: async (a: Record<string, unknown>) => void alerts.push(a) });
  let clock = 0;
  const web = fakeWeb(WEB);
  const deps = {
    site: { fetch: web.fetch as never, clock: () => (clock += 10) },
    pagespeed: { fetch: (async () => new Response(JSON.stringify(LIGHTHOUSE), { status: 200, headers: { "content-type": "application/json" } })) as never, key: null },
    alert: async (a: Record<string, unknown>) => void alerts.push(a),
  };
  const params = (eid: string) => ({ params: Promise.resolve({ engagementId: eid }) });
  const post = (eid: string, body: Record<string, unknown>) => {
    const url = `http://t.test/api/ai-audit/${eid}`;
    const r = new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://t.test" }, body: JSON.stringify(body) }) as Request & { nextUrl: URL };
    Object.defineProperty(r, "nextUrl", { value: new URL(url) });
    return route.POST(r as never, params(eid));
  };
  const parsed = (text: string) => {
    const r = tr.parseTranscriptText(text);
    assert.ok(r.ok);
    return r.ok ? r.value : (null as never);
  };
  const approveAs = async (approvalId: string, who: { id: string; email: string }) => {
    await db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status IN ('pending', 'failed')", args: [who.id, new Date().toISOString(), approvalId] });
    return execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: who.id, email: who.email } }, executors.defaultExecutorDeps() as never);
  };

  /** An engagement through Gate 1: its lead, a consented call, the client's figures, and CC's approval. */
  let leadN = 0;
  const authorized = async (name: string, website: string | null) => {
    leadN += 1;
    const lead = `7c000000-0000-4000-8000-0000000000${String(leadN).padStart(2, "0")}`;
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [lead, OASIS, JSON.stringify({ stage: "qualified", company: `[TEST] ${name}`, name: "Test Owner", email: `owner+r${leadN}@fixture.test`, website, city: "Calgary" })],
    });
    const o = await store.openEngagement(db, { tenantId: OASIS, leadId: lead, actor: cc, now: NOW(), isFixture: true });
    assert.ok(o.ok);
    const eid = o.ok ? o.engagement.id : "";
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "call_scheduled", actor: cc, now: NOW() })).ok);
    const t = await transcripts.addTranscript(db, {
      tenantId: OASIS,
      engagementId: eid,
      parsed: parsed("Dana: The shop misses about 10 calls a week, and admin eats 8 hours a week."),
      source: "paste",
      consent: { recording: true, ai: true, basis: "owner_attested", by: USERS.cc.id },
      actor: cc,
      now: NOW(),
    });
    assert.ok(t.ok);
    const f = (key: string, value: unknown, source_type = "call_notes") =>
      versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: key, value, label: "client_reported", source_type } as never, actor: cc, now: NOW() });
    await f("sales.missed_calls_per_week", 10, "transcript");
    await f("sales.close_rate_pct", 30);
    await f("sales.avg_job_value", 500);
    await f("ops.admin_hours_per_week", 8);
    await f("consent.recording", true);
    await f("consent.ai_processing", true);
    // A drafted fact carries the call's own words, as extraction leaves it.
    const e0 = (await store.getEngagement(db, OASIS, eid))!;
    await db.execute({
      sql: "UPDATE ai_audit_profile_fields SET evidence_quote = ?, source_ref = ? WHERE tenant_id = ? AND profile_version_id = ? AND field_key = 'sales.missed_calls_per_week'",
      args: ["misses about 10 calls a week", JSON.stringify({ transcript_id: t.ok ? t.transcript.id : "", from: 1, to: 1, speakers: ["Dana"] }), OASIS, e0.current_profile_version_id],
    });
    const card = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(card.ok, !card.ok ? card.error : "");
    const out = await approveAs(card.ok ? card.approvalId : "", USERS.cc);
    assert.equal(out.ok && (out.approval.execution_result as { outcome?: string } | null)?.outcome, "authorized", JSON.stringify(out));
    assert.equal((await store.getEngagement(db, OASIS, eid))!.stage, "generating");
    return { eid, transcriptId: t.ok ? t.transcript.id : "" };
  };
  const stepOf = async (stepId: string) => (await db.execute({ sql: "SELECT status, error_code, result_ref FROM ai_audit_steps WHERE id = ?", args: [stepId] })).rows[0];
  const claimSearch = async () => {
    const res = await runner.handleToolsClaim(macRequest("claim", { label: "CC's Mac", version: "1.0.0", tools: ["ai_audit_search"] }, NOW()), runnerDeps(NOW()) as never);
    return ((await res.json()) as { job: { job_id: string; lease_id: string; tool_key: string; input: Record<string, unknown> } | null }).job;
  };

  console.log("evidence rules");
  const now = new Date("2026-10-26T12:00:00Z");
  const page = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, kind: "listing" as const, text, reliability: "low" as const, ...extra });
  const finding = (id: string, statement: string, label: "verified" | "client_reported" | "estimate" | "hypothesis", source_ids: string[], metric?: { value: number; unit: string }) => ({
    id,
    title: id,
    statement,
    label,
    source_ids,
    ...(metric ? { metric } : {}),
  });
  await check("a page's claim is Verified only when its stored text states it: every figure, and most of its words", () => {
    const sources = [page("s1", "Fixture Plumbing. Rated 4.8 stars from 120 reviews in Calgary.")];
    const out = evidence.enforceEvidence(
      [
        finding("a", "Rated 4.8 stars from 120 reviews", "verified", ["s1"], { value: 4.8, unit: "stars" }),
        finding("b", "Rated 4.8 stars from 300 reviews", "verified", ["s1"], { value: 4.8, unit: "stars" }),
        finding("c", "Offers emergency service around the clock", "verified", ["s1"]),
        finding("d", "Rated 4.8 stars", "verified", ["nope"], { value: 4.8, unit: "stars" }),
      ],
      sources,
      now,
    );
    assert.deepEqual(out.findings.map((f) => [f.id, f.label]), [["a", "verified"], ["c", "hypothesis"]]);
    assert.deepEqual(out.changes.map((c) => [c.finding_id, c.action]), [["b", "dropped"], ["c", "downgraded"], ["d", "dropped"]]);
  });
  await check("a benchmark counts only from a reliable source dated in the last three years; a measurement and CC's note need no page", () => {
    const pub = (id: string, reliability: string, published_at: string | null) => ({ id, kind: "publication" as const, text: "Small trades firms miss 27 percent of calls.", reliability: reliability as "high", published_at });
    const claim = (id: string, src: string) => finding(id, "Small trades firms miss 27 percent of calls", "verified", [src], { value: 27, unit: "%" });
    const out = evidence.enforceEvidence(
      [claim("fresh", "p1"), claim("old", "p2"), claim("weak", "p3"), finding("m", "The home page scores 42 for speed", "verified", ["m1"], { value: 42, unit: "/100" }), finding("n", "Books 30 jobs a month", "verified", ["n1"], { value: 30, unit: "jobs" })],
      [pub("p1", "high", "2025-02-01T00:00:00Z"), pub("p2", "high", "2021-01-01T00:00:00Z"), pub("p3", "low", "2026-01-01T00:00:00Z"), { id: "m1", kind: "measurement", reliability: "own_measurement" }, { id: "n1", kind: "other", confirmed_note: "Their booking export shows 30" }],
      now,
    );
    assert.deepEqual(out.findings.map((f) => f.id), ["fresh", "m", "n"]);
  });
  await check("Client-reported needs a client source, an estimate never comes from research, a hypothesis carries no figure", () => {
    const out = evidence.enforceEvidence(
      [
        finding("cr", "Misses 10 calls a week", "client_reported", ["c1"]),
        finding("cr2", "Misses 10 calls a week", "client_reported", ["s1"]),
        finding("est", "About 40 leads", "estimate", ["c1"]),
        finding("h1", "Calls after hours go unanswered", "hypothesis", ["s1"]),
        finding("h2", "About 30 percent of calls go unanswered", "hypothesis", ["s1"]),
      ],
      [{ id: "c1", kind: "client" }, page("s1", "anything")],
      now,
    );
    assert.deepEqual(out.findings.map((f) => [f.id, f.label]), [["cr", "client_reported"], ["h1", "hypothesis"]]);
    assert.ok(out.findings.find((f) => f.id === "h1")?.how_to_test, "a hypothesis says how to test it");
  });

  console.log("impact calculator");
  await check("estimates are ranges from the client's own figures and the stated assumptions; a missing figure is a named gap", () => {
    const inputs = {
      "sales.missed_calls_per_week": { value: 10, label: "client_reported" as const, sourceId: "c1" },
      "sales.close_rate_pct": { value: 30, label: "client_reported" as const, sourceId: "c2" },
      "sales.avg_job_value": { value: 500, label: "client_reported" as const, sourceId: "c3" },
      "ops.admin_hours_per_week": { value: 8, label: "client_reported" as const, sourceId: "c4" },
    };
    const r = impact.estimateImpact(inputs);
    const missed = r.estimates.find((e) => e.id === "est-missed-calls")!;
    assert.deepEqual([missed.low, missed.high, missed.unit, missed.period], [1300, 3250, "$", "per month"], "10 a week x 52/12 x 30% x $500 x 20 to 50%");
    const hours = r.estimates.find((e) => e.id === "est-admin-hours")!;
    assert.deepEqual([hours.low, hours.high], [1.5, 3]);
    assert.ok(!r.estimates.some((e) => e.id === "est-admin-cost"), "no hourly cost, no dollar figure for the time");
    assert.ok(r.gaps.some((g) => /cost of an hour of staff time/.test(g.why)));
    assert.ok(r.gaps.some((g) => /new leads per month/.test(g.why) && /typical first response time/.test(g.why)));
    const mine = impact.estimateImpact(inputs, { missed_call_recovery: { low: 0.3, high: 0.6 } }).estimates.find((e) => e.id === "est-missed-calls")!;
    assert.deepEqual([mine.low, mine.high], [1950, 3900]);
    const quick = impact.estimateImpact({ ...inputs, "sales.leads_per_month": { value: 40, label: "client_reported", sourceId: "c5" }, "sales.response_time_hours": { value: 0.5, label: "client_reported", sourceId: "c6" } });
    assert.ok(!quick.estimates.some((e) => e.id === "est-fast-replies"), "replies already within the hour: no lift is counted");
  });
  await check("CC's ranges are checked: unknown keys, reversed or out-of-range values are refused", () => {
    assert.deepEqual(impact.validateOverrides({ nope: { low: 0.1, high: 0.2 } }), { ok: false, error: "assumption_unknown" });
    assert.deepEqual(impact.validateOverrides({ missed_call_recovery: { low: 0.6, high: 0.3 } }), { ok: false, error: "assumption_range" });
    assert.deepEqual(impact.validateOverrides({ missed_call_recovery: { low: 0.1, high: 1.4 } }), { ok: false, error: "assumption_range" });
    assert.deepEqual(impact.validateOverrides([]), { ok: false, error: "assumptions_invalid" });
    assert.ok(impact.validateOverrides({ admin_automation_share: { low: 0, high: 1 } }).ok);
  });

  console.log("web search and PageSpeed");
  await check("the search prompt holds the business's public facts only, fenced as data and scrubbed", () => {
    const key = ["sk", "live", "x".repeat(24)].join("_");
    const p = search.searchPrompt({ businessName: `Fixture Co ${key}`, website: "https://fixture-plumbing.ca", city: "Calgary", businessType: null });
    assert.match(p.prompt, /UNTRUSTED_INPUT_BEGIN[\s\S]*Fixture Co/);
    assert.ok(!p.prompt.includes(key), "a key in the name never reaches the model");
    assert.match(p.system, /Never guess, estimate or round a number/);
  });
  await check("the search's answer is checked: public addresses, known kinds, no repeats, at most twelve; pages behind a login are known", () => {
    const r = search.parseSearchAnswer(SEARCH_ANSWER);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.results.map((x) => new URL(x.url).hostname), ["www.yelp.ca", "www.instagram.com", "closed-directory.ca"]);
    assert.ok(r.refused.some((x) => /127\.0\.0\.1 is not a public web address/.test(x)));
    assert.ok(search.loginWalled(new URL("https://www.instagram.com/fixtureplumbing")));
    assert.ok(!search.loginWalled(new URL("https://www.yelp.ca/biz/x")));
    const many = JSON.stringify({ results: Array.from({ length: 30 }, (_, i) => ({ url: `https://site${i}.ca/`, title: "t", kind: "listing", claims: [] })) });
    const capped = search.parseSearchAnswer(many);
    assert.ok(capped.ok && capped.results.length === search.SEARCH_MAX_RESULTS);
    assert.deepEqual(search.parseSearchAnswer("no json here"), { ok: false, error: "unreadable" });
  });
  await check("PageSpeed's answer is read defensively: what is missing is null, never guessed", () => {
    const ok = pagespeed.parsePageSpeed("https://fixture-plumbing.ca/", LIGHTHOUSE, "2026-10-26T00:00:00Z");
    assert.ok(ok.ok && ok.scores.performance === 42 && ok.scores.accessibility === 91 && ok.timings.lcp_ms === 5400);
    const thin = pagespeed.parsePageSpeed("https://x.ca/", { lighthouseResult: { categories: { performance: { score: 2 } }, audits: {} } }, "2026-10-26T00:00:00Z");
    assert.ok(thin.ok && thin.scores.performance === null && thin.timings.lcp_ms === null);
    assert.equal(pagespeed.parsePageSpeed("https://x.ca/", { nothing: true }, "t").ok, false);
  });

  console.log("a research run");
  const first = await authorized("Research Fixture Co", "https://fixture-plumbing.ca");
  let stepId = "";
  await check("research starts only after Gate 1, once; a second start hands back the same run", async () => {
    const r = await research.startResearch(db, { tenantId: OASIS, engagementId: first.eid, actor: cc, now: NOW() });
    assert.ok(r.ok && r.created, JSON.stringify(r));
    stepId = r.ok ? r.stepId : "";
    const again = await research.startResearch(db, { tenantId: OASIS, engagementId: first.eid, actor: cc, now: NOW() });
    assert.ok(again.ok && !again.created && again.stepId === stepId);
  });
  await check("one phase per call: the website, then PageSpeed, then the search is handed to the Mac holding ids only", async () => {
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps }), "advanced");
    const site = JSON.parse(String((await stepOf(stepId)).result_ref)) as { phase: string; site?: { pagesRead?: number } };
    assert.equal(site.phase, "pagespeed");
    assert.ok((site.site?.pagesRead ?? 0) >= 1, "the home page was read");
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps }), "advanced");
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps }), "advanced");
    assert.equal(String((await stepOf(stepId)).status), "waiting_runner");
    const jobs = await db.execute({ sql: "SELECT input_json FROM tool_jobs WHERE tenant_id = ? AND tool_key = 'ai_audit_search'", args: [OASIS] });
    assert.equal(jobs.rows.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(String(jobs.rows[0].input_json))).sort(), ["engagement_id", "step_id"]);
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps }), "waiting", "nothing moves until the Mac answers");
  });
  await check("the Mac is handed the prompt at claim time, with the business's public facts and never the call", async () => {
    const job = await claimSearch();
    assert.ok(job && job.tool_key === "ai_audit_search");
    const prompt = String(job!.input.prompt);
    assert.equal(job!.input.purpose, "search");
    assert.ok(prompt.includes("Research Fixture Co") && prompt.includes("fixture-plumbing.ca") && prompt.includes("Calgary"));
    assert.ok(!/calls a week|eats 8 hours|500/.test(prompt), "nothing the client said reaches the search");
    const done = await runner.handleToolsComplete(macRequest("complete", { job_id: job!.job_id, lease_id: job!.lease_id, tool_key: "ai_audit_search", text: SEARCH_ANSWER }, NOW()), runnerDeps(NOW()) as never);
    assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
    const stored = String((await db.execute({ sql: "SELECT result_json FROM tool_jobs WHERE id = ?", args: [job!.job_id] })).rows[0].result_json);
    assert.ok(stored.includes('"search"') && !stored.includes("/admin"), "only the checked list is kept");
  });
  await check("each page found is read by the Command Center under its own robots.txt; a login page is a gap, never read", async () => {
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps }), "advanced");
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps }), "advanced");
    assert.ok(web.seen.includes("https://www.yelp.ca/biz/fixture-plumbing-calgary"));
    assert.ok(web.seen.includes("https://closed-directory.ca/robots.txt") && !web.seen.includes("https://closed-directory.ca/page"), "a page its robots.txt closes is not read");
    assert.ok(!web.seen.some((u) => u.includes("instagram.com")), "a page behind a login is not read");
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId, now: NOW(), deps }), "finished");
    assert.equal(String((await stepOf(stepId)).status), "done");
  });
  await check("the stored run: labels decided by the evidence rules, estimates with their inputs, every gap, no word of the call, and frozen", async () => {
    const latest = await research.latestResearch(db, OASIS, first.eid);
    assert.ok(latest && latest.version_no === 1);
    const pack = latest!.content;
    const by = (label: string) => pack.findings.filter((f) => f.label === label);
    assert.ok(by("client_reported").some((f) => /Missed calls per week: 10/.test(f.statement)));
    assert.ok(by("verified").some((f) => /scores the home page 42 out of 100 for speed/.test(f.statement)));
    assert.ok(by("verified").some((f) => f.statement === "Rated 4.8 stars from 120 reviews"), "a claim the stored page states stands");
    assert.ok(!pack.findings.some((f) => /300 reviewers/.test(f.statement)), "the model's own number does not");
    assert.ok(pack.evidence_changes.some((c) => c.action === "dropped"));
    assert.ok(pack.estimates.some((e) => e.id === "est-missed-calls" && e.low === 1300 && e.high === 3250));
    const gaps = pack.gaps.map((g) => g.why).join(" | ");
    assert.match(gaps, /instagram\.com could not be read without a login/);
    assert.match(gaps, /closed-directory\.ca does not allow automated reading/);
    assert.ok(pack.search_refused.some((x) => /127\.0\.0\.1/.test(x)));
    const raw = JSON.stringify(pack);
    assert.ok(!raw.includes("misses about 10 calls a week") && !raw.includes("calls a week"), "the call's words stay in the profile, where a delete can reach them");
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_research SET status = 'ready' WHERE id = ?", args: [latest!.id] }), /ai_audit_research_frozen/);
    assert.ok(alerts.some((a) => a.alertType === "ai_audit_research_ready"));
  });
  await check("the page shows the run and the estimates with CC's ranges; only the owner changes the ranges or runs it again", async () => {
    await login(USERS.admin);
    assert.equal((await post(first.eid, { action: "start_research" })).status, 403);
    assert.equal((await post(first.eid, { action: "save_assumptions", overrides: { missed_call_recovery: { low: 0.3, high: 0.6 } } })).status, 403);
    await login(USERS.cc);
    const bad = await post(first.eid, { action: "save_assumptions", overrides: { missed_call_recovery: { low: 0.6, high: 0.3 } } });
    assert.deepEqual([bad.status, ((await bad.json()) as { error?: string }).error], [400, "assumption_range"]);
    assert.equal((await post(first.eid, { action: "save_assumptions", overrides: { missed_call_recovery: { low: 0.3, high: 0.6 } } })).status, 200);
    const v = (await view.engagementView(db, OASIS, first.eid, NOW()))!.research!;
    assert.equal(v.latest?.version_no, 1);
    const est = v.estimates.find((e) => e.id === "est-missed-calls")!;
    assert.deepEqual([est.low, est.high], [1950, 3900], "recomputed from the run's stored inputs with CC's range");
    assert.equal(v.latest!.content.estimates.find((e) => e.id === "est-missed-calls")!.low, 1300, "the stored run keeps the range it was built with");
    const again = await post(first.eid, { action: "start_research" });
    assert.equal(again.status, 200);
    assert.ok(((await again.json()) as { created?: boolean }).created);
    await login(null);
  });
  await check("a voided authorization stops the run: the Mac is handed nothing, and the run says why", async () => {
    const step2 = (await research.latestResearchStep(db, OASIS, first.eid))!;
    for (let i = 0; i < 3; i++) await research.advanceResearch(db, { tenantId: OASIS, stepId: step2.id, now: NOW(), deps });
    assert.equal(String((await stepOf(step2.id)).status), "waiting_runner");
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: first.eid, id: first.transcriptId, actor: cc, now: NOW() }), { ok: true });
    assert.equal(await claimSearch(), null, "no prompt is handed out");
    const job = (await db.execute({ sql: "SELECT status, error_code FROM tool_jobs WHERE tenant_id = ? AND tool_key = 'ai_audit_search' AND json_extract(input_json, '$.step_id') = ?", args: [OASIS, step2.id] })).rows[0];
    assert.deepEqual([String(job.status), String(job.error_code)], ["failed", "ai_audit_research_not_permitted"]);
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId: step2.id, now: NOW(), deps }), "failed");
    const s = await stepOf(step2.id);
    assert.deepEqual([String(s.status), String(s.error_code)], ["cancelled", "not_authorized"]);
    assert.deepEqual(await research.startResearch(db, { tenantId: OASIS, engagementId: first.eid, actor: cc, now: NOW() }), { ok: false, error: "not_authorized" });
  });
  await check("a search no Mac runs within six hours is skipped with a gap, and a business with no website is said so", async () => {
    const { eid } = await authorized("No Website Co", null);
    const r = await research.startResearch(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW() });
    assert.ok(r.ok);
    const id = r.ok ? r.stepId : "";
    for (let i = 0; i < 3; i++) assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId: id, now: NOW(), deps }), "advanced");
    const later = new Date(Date.now() + research.MAC_SEARCH_WAIT_MS + 60_000);
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId: id, now: later, deps }), "advanced");
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId: id, now: later, deps }), "advanced");
    assert.equal(await research.advanceResearch(db, { tenantId: OASIS, stepId: id, now: later, deps }), "finished");
    const pack = (await research.latestResearch(db, OASIS, eid))!.content;
    const gaps = pack.gaps.map((g) => g.why).join(" | ");
    assert.match(gaps, /No Mac ran the web search within six hours/);
    assert.match(gaps, /No website is known for the business/);
    assert.deepEqual(pack.plan.map((m) => [m.module, m.status]), [["profile", "done"], ["site", "skipped"], ["pagespeed", "skipped"], ["search", "skipped"]]);
    const job = (await db.execute({ sql: "SELECT status, error_code FROM tool_jobs WHERE tenant_id = ? AND tool_key = 'ai_audit_search' AND json_extract(input_json, '$.step_id') = ?", args: [OASIS, id] })).rows[0];
    assert.deepEqual([String(job.status), String(job.error_code)], ["failed", "runner_offline"]);
  });
  await check("the tick starts research for an engagement past Gate 1 and moves it on; other steps are untouched", async () => {
    const { eid } = await authorized("Tick Research Co", "https://fixture-plumbing.ca");
    const tickDeps = { payment: { alert: async () => undefined } as never, onboarding: {} as never, site: deps.site, research: deps };
    const one = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps });
    assert.deepEqual(one.errors, [], JSON.stringify(one.errors));
    assert.ok(one.researchStarted >= 1);
    const step = (await research.latestResearchStep(db, OASIS, eid))!;
    assert.ok(step && ["queued", "running"].includes(step.status));
    const two = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps });
    assert.ok(two.researchAdvanced >= 1, JSON.stringify(two));
    assert.equal((await research.latestResearchStep(db, OASIS, eid))!.phase, "pagespeed");
  });

  finish("ai-audit-research");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
