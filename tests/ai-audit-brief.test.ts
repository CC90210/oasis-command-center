/**
 * ai-audit-brief.test.ts — phase 2d of the Free AI Audit: the pre-call
 * research brief, built by code from the client's own website and the
 * answers they gave on the AI-audit form.
 *
 * Pins:
 *   - only a public website is fetched: IP addresses in every spelling,
 *     internal and reserved names, ports and credentials are refused, social
 *     profiles are recorded and never fetched, and a redirect into a private
 *     address is not followed;
 *   - fetching is GET only, with an honest user agent, manual redirects (at
 *     most five), robots.txt's rules for everyone, a size cap and a time budget;
 *   - the checks read the HTML in linear time: a hostile page full of unclosed
 *     tags is read in well under a second;
 *   - the brief labels the site's checks Verified and the form's answers
 *     Client-reported; its likely problems carry no number of their own and say
 *     how to test them; what could not be checked is listed, never guessed;
 *   - a brief is stored as a version that never changes, with its sources, built
 *     by the tick once the call is booked, again when CC asks, and not after Gate 1.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-brief.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { OASIS, USERS, check, finish, login, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];

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

// ---------------------------------------------------------------------------
// A fake web: each address answers from this table, and every request is kept.
// ---------------------------------------------------------------------------

type Route = { status?: number; type?: string; body?: string; location?: string };
function fakeWeb(routes: Record<string, Route>) {
  const seen: Array<{ url: string; method: string; redirect: string; ua: string }> = [];
  const fetch = async (url: string, init: { method: string; redirect: string; signal: AbortSignal; headers: Record<string, string> }) => {
    seen.push({ url, method: init.method, redirect: init.redirect, ua: init.headers["user-agent"] ?? "" });
    const r = routes[url];
    if (!r) throw new TypeError("fetch failed");
    const headers = new Headers();
    if (r.type !== undefined) headers.set("content-type", r.type);
    else headers.set("content-type", "text/html; charset=utf-8");
    if (r.location) headers.set("location", r.location);
    return new Response(r.status && r.status >= 300 && r.status < 400 ? null : (r.body ?? ""), { status: r.status ?? 200, headers });
  };
  return { fetch, seen };
}

const HOME = `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fixture Plumbing | Calgary plumbers</title>
<meta name="description" content="Emergency plumbing in Calgary, 24/7.">
<meta name="generator" content="WordPress 6.6">
<link rel="stylesheet" href="/wp-content/themes/x/style.css">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Fixture Plumbing"}</script>
</head><body>
<header><a href="/">Home</a> <a href="/contact/">Contact us</a> <a href="/book">Book a visit</a> <a href="/services">Services</a>
<a href="/pricing">Prices</a> <a href="/about">About</a> <a href="/private/team">Our team</a> <a href="https://elsewhere.example.org/contact">Partner</a>
<a href="/brochure.pdf">Brochure</a></header>
<main><h1>Fast, friendly plumbing</h1><p>${"We fix leaks, drains and water heaters across the city. ".repeat(8)}</p>
<a href="tel:+14035550199">Call (403) 555-0199</a> <a href="mailto:hello@fixture-plumbing.ca">Email us</a>
<form role="search" action="/search"><input type="search" name="s"></form>
</main>
<footer><a href="https://www.facebook.com/fixtureplumbing">Facebook</a> <a href="https://instagram.com/fixtureplumbing">Instagram</a> <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a></footer>
</body></html>`;

const CONTACT = `<html><head><title>Contact</title></head><body>
<form action="/send" method="post"><input type="text" name="your-name"><input type="email" name="your-email"><textarea name="message"></textarea><button>Send</button></form>
</body></html>`;
const BOOK = `<html><head><title>Book</title></head><body><a href="https://calendly.com/fixture-plumbing/visit">Pick a time</a></body></html>`;

async function main() {
  const url = await import("../lib/ai-audit/site-url");
  const checksMod = await import("../lib/ai-audit/site-checks");
  const fetchMod = await import("../lib/ai-audit/site-fetch");
  const briefMod = await import("../lib/ai-audit/brief");

  console.log("which address may be read");
  await check("only a business's own public website is a target; everything else is refused or recorded as social", () => {
    const t = (raw: string) => url.siteTarget(raw);
    assert.deepEqual(t("fixture-plumbing.ca"), { kind: "site", start: "https://fixture-plumbing.ca/", origin: "https://fixture-plumbing.ca", host: "fixture-plumbing.ca", pathPrefix: "/" });
    assert.equal((t("https://www.fixture-plumbing.ca/services?x=1") as { start: string }).start, "https://www.fixture-plumbing.ca/", "the checks start at the home page");
    assert.deepEqual(t("@fixtureplumbing"), { kind: "social", platform: "a social network", url: null });
    assert.equal((t("instagram.com/fixtureplumbing") as { platform: string }).platform, "Instagram");
    assert.equal((t("https://www.google.com/maps/place/Fixture") as { platform: string }).platform, "Google Maps");
    const wix = t("https://acme.wixsite.com/fixture/about") as { start: string; pathPrefix: string };
    assert.deepEqual([wix.start, wix.pathPrefix], ["https://acme.wixsite.com/fixture/", "/fixture"], "a shared builder site starts in its own folder");
    for (const bad of [
      "http://127.0.0.1/", "http://127.0.0.2/", "http://2130706433/", "http://0x7f.0.0.1/", "http://127.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "localhost:3000", "http://localhost/", "metadata.google.internal", "printer.local",
      "acme", "acme.test", "https://user:pw@fixture-plumbing.ca/", "fixture-plumbing.ca:8080", "ftp://fixture-plumbing.ca/",
    ]) {
      assert.equal(t(bad).kind, "none", bad);
    }
    assert.deepEqual(t(""), { kind: "none", reason: "empty" });
    assert.deepEqual(t("call me maybe"), { kind: "none", reason: "not_a_url" });
    assert.equal(url.isPublicHostname("xn--bcher-kva.ch"), true, "an international name is fine");
  });

  console.log("the checks");
  const page = (u: string, html: string, extra: Partial<import("../lib/ai-audit/site-checks").PageSnapshot> = {}) => ({ url: u, finalUrl: u, status: 200, contentType: "text/html", html, bytes: html.length, ms: 420, truncated: false, ...extra });
  await check("a well-kept site: every check says what it found and where", () => {
    const res = checksMod.runSiteChecks({
      pages: [page("https://fixture-plumbing.ca/", HOME), page("https://fixture-plumbing.ca/contact/", CONTACT), page("https://fixture-plumbing.ca/book", BOOK)],
      https: { served: true, httpRedirects: true },
      sitemap: { found: true, url: "https://fixture-plumbing.ca/sitemap.xml" },
    });
    const by = new Map(res.map((c) => [c.key, c]));
    for (const k of ["https", "mobile_viewport", "title", "meta_description", "click_to_call", "email_link", "contact_form", "online_booking", "analytics", "platform", "structured_data", "social_links", "sitemap", "html_size", "response_time"] as const) {
      assert.equal(by.get(k)?.status, "yes", `${k}: ${by.get(k)?.detail}`);
    }
    assert.equal(by.get("live_chat")?.status, "no");
    assert.deepEqual(by.get("online_booking")?.found, ["Calendly"]);
    assert.equal(by.get("online_booking")?.evidence?.url, "https://fixture-plumbing.ca/book");
    assert.deepEqual(by.get("platform")?.found, ["WordPress"]);
    assert.deepEqual(by.get("structured_data")?.found, ["Plumber"]);
    assert.deepEqual(by.get("social_links")?.found, ["Facebook", "Instagram"], "a share button is not a profile");
    assert.equal(by.get("contact_form")?.evidence?.url, "https://fixture-plumbing.ca/contact/", "the site search box is not a contact form");
    assert.equal(res.length, checksMod.CHECK_KEYS.length);
  });
  await check("a bare site says no where it shows nothing; a page that builds itself in the browser says unknown", () => {
    const bare = `<html><head><title>Old Shop</title></head><body><p>${"We sell things. ".repeat(30)}</p><form action="/search"><input name="q"></form></body></html>`;
    const r = new Map(checksMod.runSiteChecks({ pages: [page("http://old-shop.ca/", bare)], https: { served: false, httpRedirects: null }, sitemap: { found: false, url: null } }).map((c) => [c.key, c.status]));
    for (const k of ["https", "mobile_viewport", "meta_description", "click_to_call", "contact_form", "online_booking", "live_chat", "analytics", "structured_data", "social_links", "sitemap"] as const) assert.equal(r.get(k), "no", k);
    const spa = `<html><head><title>App</title><script src="/static/app.js"></script></head><body><div id="root"></div></body></html>`;
    const s = new Map(checksMod.runSiteChecks({ pages: [page("https://spa-shop.ca/", spa)], https: { served: true, httpRedirects: null }, sitemap: null }).map((c) => [c.key, c.status]));
    for (const k of ["click_to_call", "contact_form", "online_booking", "live_chat", "analytics", "social_links"] as const) assert.equal(s.get(k), "unknown", k);
    assert.equal(s.get("sitemap"), "unknown");
  });
  await check("a hostile page full of unclosed tags is read in linear time", () => {
    const hostile = [
      "<a ".repeat(150_000),
      "<script>".repeat(40_000),
      "<form>".repeat(40_000) + "<input name=email>".repeat(1_000),
      "<meta name=x content='".repeat(30_000),
      "<<<<".repeat(100_000),
      `<a href="${"x".repeat(200_000)}`,
    ];
    for (const html of hostile) {
      const started = Date.now();
      checksMod.runSiteChecks({ pages: [page("https://hostile.ca/", html.slice(0, 600_000))], https: { served: true, httpRedirects: null }, sitemap: null });
      checksMod.pagesToRead(page("https://hostile.ca/", html.slice(0, 600_000)), () => true);
      checksMod.visibleText(html.slice(0, 600_000));
      const took = Date.now() - started;
      assert.ok(took < 1_500, `took ${took} ms on ${JSON.stringify(html.slice(0, 20))}`);
    }
  });
  await check("the pages worth reading are the site's own contact, booking, services, pricing and about pages", () => {
    const sameSite = (u: URL) => u.hostname === "fixture-plumbing.ca";
    const picked = checksMod.pagesToRead(page("https://fixture-plumbing.ca/", HOME), sameSite);
    assert.deepEqual(picked, [
      "https://fixture-plumbing.ca/contact/",
      "https://fixture-plumbing.ca/book",
      "https://fixture-plumbing.ca/services",
      "https://fixture-plumbing.ca/pricing",
      "https://fixture-plumbing.ca/about",
      "https://fixture-plumbing.ca/private/team",
    ]);
  });
  await check("robots.txt: the sitemap is found and closed paths are respected", () => {
    const r = checksMod.readRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nDisallow: /*.php$\nSitemap: https://fixture-plumbing.ca/sitemap.xml\n");
    assert.deepEqual(r, { sitemaps: ["https://fixture-plumbing.ca/sitemap.xml"], disallow: ["/private/", "/*.php$"] });
    assert.equal(checksMod.robotsAllow("/private/area", r.disallow), false);
    assert.equal(checksMod.robotsAllow("/index.php", r.disallow), false);
    assert.equal(checksMod.robotsAllow("/index.php?x=1", r.disallow), true);
    assert.equal(checksMod.robotsAllow("/contact/", r.disallow), true);
  });

  console.log("reading a site");
  const site = url.siteTarget("fixture-plumbing.ca") as Extract<import("../lib/ai-audit/site-url").SiteTarget, { kind: "site" }>;
  const ROUTES: Record<string, Route> = {
    "https://fixture-plumbing.ca/": { body: HOME },
    "http://fixture-plumbing.ca/": { status: 301, location: "https://fixture-plumbing.ca/" },
    "https://fixture-plumbing.ca/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /private/\nSitemap: https://fixture-plumbing.ca/sitemap.xml\n" },
    "https://fixture-plumbing.ca/contact/": { body: CONTACT },
    "https://fixture-plumbing.ca/book": { body: BOOK },
    "https://fixture-plumbing.ca/services": { status: 302, location: "/services/" },
    "https://fixture-plumbing.ca/services/": { body: "<html><title>Services</title><body>Drains</body></html>" },
    "https://fixture-plumbing.ca/pricing": { type: "application/pdf", body: "%PDF" },
    "https://fixture-plumbing.ca/about": { status: 302, location: "http://127.0.0.1/admin" },
  };
  let clock = 0;
  const deps = (web: ReturnType<typeof fakeWeb>) => ({ fetch: web.fetch as never, clock: () => (clock += 10) });
  await check("a site is read with GETs only, an honest user agent, each redirect checked, and robots.txt followed", async () => {
    const web = fakeWeb(ROUTES);
    const r = await fetchMod.readSite(site, deps(web));
    assert.ok(web.seen.every((s) => s.method === "GET" && s.redirect === "manual" && s.ua.startsWith("OASIS-AI-Audit/")));
    assert.ok(!web.seen.some((s) => s.url.includes("/private/")), "a path robots.txt closes is never fetched");
    assert.ok(!web.seen.some((s) => s.url.startsWith("http://127.0.0.1")), "a redirect into a private address is not followed");
    assert.ok(!web.seen.some((s) => s.url.includes("elsewhere.example.org")), "other sites' pages are not read");
    assert.ok(r.notes.some((n) => n.includes("/private/team") && n.includes("robots.txt")), r.notes.join(" | "));
    assert.ok(r.notes.some((n) => n.includes("/about") && n.includes("not a public website")));
    assert.ok(r.notes.some((n) => n.includes("/pricing") && n.includes("not a web page")));
    const by = new Map(r.checks.map((c) => [c.key, c]));
    assert.equal(by.get("online_booking")?.status, "yes");
    assert.equal(by.get("contact_form")?.status, "yes");
    assert.equal(by.get("sitemap")?.status, "yes");
    assert.equal(by.get("https")?.detail, "The site answers on a secure HTTPS address.");
    assert.equal(r.pages.find((p) => p.url === "https://fixture-plumbing.ca/services")?.finalUrl, "https://fixture-plumbing.ca/services/", "a same-site redirect is followed");
  });
  await check("a site that only answers on plain HTTP is read there and reported; a redirect loop stops at five", async () => {
    const web = fakeWeb({ "http://fixture-plumbing.ca/": { body: HOME } });
    const r = await fetchMod.readSite(site, deps(web));
    assert.equal(r.checks.find((c) => c.key === "https")?.status, "no");
    const loop: Record<string, Route> = {};
    for (let i = 0; i < 10; i++) loop[`https://loop.ca/${i ? `p${i}` : ""}`] = { status: 302, location: `https://loop.ca/p${i + 1}` };
    const looped = await fetchMod.readPage("https://loop.ca/", deps(fakeWeb(loop)), { accept: "html", deadline: clock + 1_000_000 });
    assert.deepEqual(looped.ok ? null : looped.error, "too_many_redirects");
  });
  await check("a page is read up to the size cap; the time budget stops what is left", async () => {
    const big = `<html><title>Big</title><body>${"x".repeat(fetchMod.MAX_PAGE_BYTES + 50_000)}</body></html>`;
    const r = await fetchMod.readPage("https://big.ca/", deps(fakeWeb({ "https://big.ca/": { body: big } })), { accept: "html", deadline: clock + 1_000_000 });
    assert.ok(r.ok && r.page.truncated && r.page.bytes === fetchMod.MAX_PAGE_BYTES);
    const late = await fetchMod.readPage("https://big.ca/", deps(fakeWeb({})), { accept: "html", deadline: clock - 1 });
    assert.deepEqual(late.ok ? null : late.error, "out_of_time");
  });

  console.log("the brief");
  const form = {
    company: "Fixture Plumbing",
    website: "fixture-plumbing.ca",
    automation_goal: "sales_leadgen",
    bottleneck_detail: "We miss calls when we are on a job and people book someone else.",
    tried_before: "tools",
    current_tools: "Jobber, Gmail, a paper diary",
    monthly_revenue: "50k_250k",
    team_size: "6_20",
    budget: "2k_5k",
    timeframe: "30_days",
  };
  const noBookingChecks = checksMod.runSiteChecks({
    pages: [page("https://fixture-plumbing.ca/", HOME.replace(/<a href="\/book">Book a visit<\/a>/, "").replace(/<script async src="https:\/\/www.googletagmanager[^<]*<\/script>/, ""))],
    https: { served: true, httpRedirects: true },
    sitemap: { found: false, url: null },
  });
  await check("the brief labels the website's checks Verified and the form's answers Client-reported", () => {
    const b = briefMod.assembleBrief({ builtAt: NOW().toISOString(), business: { name: "Fixture Plumbing", type: "local_service" }, form: { answers: form, at: null }, site: { target: site, checks: noBookingChecks, pagesRead: 1, notes: [] } });
    assert.ok(b.facts.filter((f) => f.source.kind === "site").every((f) => f.label === "verified"));
    assert.ok(b.facts.filter((f) => f.source.kind === "form").every((f) => f.label === "client_reported"));
    const revenue = b.facts.find((f) => f.id === "form:monthly_revenue");
    assert.match(revenue?.statement ?? "", /\$50K/, "the option's own words, never a figure of ours");
    assert.ok(b.facts.some((f) => f.id === "form:bottleneck_detail" && f.statement.includes("We miss calls")));
    assert.ok(b.confirm.some((c) => c.question_id === "tech-tools" && c.statement.includes("Jobber")));
  });
  await check("likely problems need evidence, carry no number of their own, and say how to test them", () => {
    const b = briefMod.assembleBrief({ builtAt: NOW().toISOString(), business: { name: "Fixture Plumbing", type: "local_service" }, form: { answers: form, at: null }, site: { target: site, checks: noBookingChecks, pagesRead: 1, notes: [] } });
    const ids = b.hypotheses.map((h) => h.id);
    assert.ok(ids.includes("booking-by-hand"), ids.join(","));
    assert.ok(ids.includes("unmeasured-visitors"));
    assert.ok(ids.includes("shelfware"), "from the form: tools nobody uses");
    // Only the home page was read here, and it has no form or chat: the brief says what it saw.
    assert.ok(ids.includes("no-way-to-ask"));
    for (const h of b.hypotheses) {
      assert.ok(!/\d/.test(h.statement), `a number in: ${h.statement}`);
      assert.ok(h.test.length > 10 && h.questions.length > 0);
    }
    assert.deepEqual(b.weight.slice(0, 4).map((w) => w.question_id), ["sales-sources", "sales-handling", "sales-conversion", "sales-lost"], "their own goal first");
    assert.ok(b.weight.length <= 6);
  });
  await check("what could not be checked is a gap, never a guess; a social profile is a gap and a likely problem", () => {
    const spa = checksMod.runSiteChecks({ pages: [page("https://spa-shop.ca/", `<html><head><title>App</title><script src="/a.js"></script></head><body><div id="root"></div></body></html>`)], https: { served: true, httpRedirects: null }, sitemap: null });
    const b = briefMod.assembleBrief({ builtAt: NOW().toISOString(), business: { name: "Spa Shop", type: "ecommerce" }, form: null, site: { target: url.siteTarget("spa-shop.ca"), checks: spa, pagesRead: 1, notes: ["https://spa-shop.ca/contact did not answer within 8 seconds."] } });
    assert.ok(b.gaps.some((g) => g.startsWith("Online booking:")));
    assert.ok(b.gaps.some((g) => g.includes("did not answer")));
    assert.ok(b.gaps.some((g) => g.includes("No AI-audit form answers")));
    assert.ok(!b.facts.some((f) => f.source.kind === "site" && f.source.check === "online_booking"), "an unknown is not stated as a fact");
    const social = briefMod.assembleBrief({ builtAt: NOW().toISOString(), business: { name: "Insta Co", type: "local_service" }, form: null, site: { target: url.siteTarget("instagram.com/instaco"), checks: [], pagesRead: 0, notes: [] } });
    assert.ok(social.gaps.some((g) => g.includes("Instagram profile")));
    assert.ok(social.hypotheses.some((h) => h.id === "no-own-site"));
  });

  console.log("storing and running it");
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of ["bravo__186_os_approvals.sql", "bravo__206_tool_jobs.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql", "bravo__241_ai_audit_briefs.sql"]) await apply(db, f);
  const store = await import("../lib/ai-audit/store");
  const lifecycle = await import("../lib/ai-audit/lifecycle");
  const briefs = await import("../lib/ai-audit/briefs");
  const tick = await import("../lib/ai-audit/tick");
  const cc = { type: "user" as const, id: USERS.cc.id };
  const lead = (n: number) => `7c000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
  const openWith = async (n: number, website: string | null, answers: Record<string, unknown> | null) => {
    const id = lead(n);
    await db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)", args: [id, OASIS, JSON.stringify({ stage: "qualified", company: `[TEST] Brief ${n}`, name: "Test Owner", email: `brief${n}@fixture.test`, ...(website ? { website } : {}) })] });
    if (answers) {
      await db.execute({ sql: "INSERT INTO lead_interactions (tenant_id, lead_id, type, channel, direction, agent_source, metadata) VALUES (?, ?, 'form_submission', 'web', 'inbound', 'ai_audit_funnel', ?)", args: [OASIS, id, JSON.stringify({ form_slug: "ai-audit", answers })] });
    }
    const o = await store.openEngagement(db, { tenantId: OASIS, leadId: id, actor: cc, now: NOW(), isFixture: true });
    assert.ok(o.ok);
    return o.ok ? o.engagement.id : "";
  };
  await check("a brief is stored as a version with one source per page read and one for the form; it never changes", async () => {
    const eid = await openWith(1, "fixture-plumbing.ca", form);
    const web = fakeWeb(ROUTES);
    const r = await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: deps(web) });
    assert.ok(r.ok && r.created, !r.ok ? r.error : "");
    const b = r.ok ? r.brief : (null as never);
    assert.equal(b.version_no, 1);
    assert.equal(b.status, "partial", "some pages could not be read, so it says so");
    const sources = await db.execute({ sql: "SELECT kind, reliability, content_sha256, excerpt FROM ai_audit_sources WHERE brief_id = ? ORDER BY kind, url", args: [b.id] });
    assert.ok(sources.rows.some((s) => String(s.kind) === "form_answers" && String(s.reliability) === "client_stated"));
    const pages = sources.rows.filter((s) => String(s.kind) === "site_page");
    assert.ok(pages.length >= 4 && pages.every((s) => String(s.reliability) === "own_measurement"));
    assert.ok(!sources.rows.some((s) => String(s.excerpt ?? "").includes("<html")), "excerpts, never pages");
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_briefs SET status = 'ready' WHERE id = ?", args: [b.id] }), /frozen/);
    const again = await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: deps(fakeWeb(ROUTES)) });
    assert.deepEqual(again, { ok: false, error: "too_soon" });
    const later = await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: new Date(Date.now() + 120_000), deps: deps(fakeWeb(ROUTES)) });
    assert.ok(later.ok && later.brief.version_no === 2);
  });
  await check("the tick builds the first brief once the call is booked, and only once", async () => {
    const eid = await openWith(2, null, form);
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "call_scheduled", actor: cc, now: NOW() })).ok);
    assert.ok((await briefs.dueBriefs(db, OASIS)).includes(eid));
    const deps2 = { payment: { alert: async () => undefined } as never, onboarding: {} as never, site: deps(fakeWeb({})) };
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: deps2 });
    assert.ok(rep.briefsBuilt >= 1, JSON.stringify(rep.errors));
    const b = await briefs.latestBrief(db, OASIS, eid);
    assert.ok(b && b.content.site.kind === "none" && b.content.gaps.includes("The lead has no website on file."));
    assert.ok(!(await briefs.dueBriefs(db, OASIS)).includes(eid));
  });
  await check("after Gate 1 no brief is built; the route builds one for a founder and refuses a quick second press", async () => {
    const eid = await openWith(3, null, form);
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'generating' WHERE id = ?", args: [eid] });
    assert.deepEqual(await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: deps(fakeWeb({})) }), { ok: false, error: "stage_closed" });
    const fresh = await openWith(4, null, null);
    const route = await import("../app/api/ai-audit/[engagementId]/route");
    const post = (body: Record<string, unknown>) => {
      const u = `http://t.test/api/ai-audit/${fresh}`;
      const r = new Request(u, { method: "POST", headers: { "content-type": "application/json", origin: "http://t.test" }, body: JSON.stringify(body) }) as Request & { nextUrl: URL };
      Object.defineProperty(r, "nextUrl", { value: new URL(u) });
      return route.POST(r as never, { params: Promise.resolve({ engagementId: fresh }) });
    };
    await login(USERS.admin);
    const built = await post({ action: "build_brief" });
    assert.equal(built.status, 200, JSON.stringify(await built.clone().json()));
    const second = await post({ action: "build_brief" });
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error?: string }).error, "brief_too_soon");
    await login(null);
  });

  finish("ai-audit-brief");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
