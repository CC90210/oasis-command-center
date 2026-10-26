/**
 * ai-audit-brief.test.ts — phase 2d of the Free AI Audit: the pre-call
 * research brief, built by code from the client's own website and the
 * answers they gave on the AI-audit form.
 *
 * Pins:
 *   - only a public website is fetched: IP addresses in every spelling,
 *     internal and reserved names, names that point at a private address
 *     (nip.io and the like), ports and credentials are refused, social
 *     profiles are recorded and never fetched, and a redirect into a private
 *     address is not followed;
 *   - fetching is GET only, over HTTPS first whatever the lead typed, with an
 *     honest user agent, manual redirects (at most five), a size cap and a time
 *     budget; robots.txt is read first and obeyed for every request, the home
 *     page and the sitemap included, as RFC 9309 reads it (shared user-agent
 *     lines, our own group, Allow, the query; one that cannot be read closes
 *     the site);
 *   - the checks and the robots.txt matcher run in linear time: 600 KB of each
 *     shape that once took seconds is read well under a second;
 *   - a Verified fact is only what our own fetch measured: nothing about a site
 *     that did not answer or whose home page did not load (the brief carries one
 *     gap, with the time), no "no" from a page cut off at the size limit, no
 *     sitemap that was not read, and every request stored as a source;
 *   - the brief labels the site's checks Verified and the form's answers
 *     Client-reported; its likely problems carry no number, in what they say or
 *     in how to test them; what could not be checked is listed, never guessed;
 *   - a brief is stored as a version that never changes, with its sources, built
 *     by the tick once the call is booked (each engagement on its own, a failing
 *     one waiting before its next try), again when CC asks, once for two presses
 *     at once, and not after Gate 1; without bravo__241 only the brief stops.
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
// A host with any address in the table answers 404 for the rest; any other
// host cannot be reached. `fail` cannot be reached either (a connection
// reset); `hang` answers only when the request is stopped.
// ---------------------------------------------------------------------------

type Route = { status?: number; type?: string; body?: string; location?: string; fail?: boolean; hang?: boolean };
function fakeWeb(routes: Record<string, Route>) {
  const seen: Array<{ url: string; method: string; redirect: string; ua: string }> = [];
  const origins = new Set(Object.keys(routes).map((u) => new URL(u).origin));
  const fetch = async (url: string, init: { method: string; redirect: string; signal: AbortSignal; headers: Record<string, string> }) => {
    seen.push({ url, method: init.method, redirect: init.redirect, ua: init.headers["user-agent"] ?? "" });
    const r = routes[url];
    if (!r) {
      if (origins.has(new URL(url).origin)) return new Response("<html><title>Not found</title></html>", { status: 404, headers: { "content-type": "text/html" } });
      throw new TypeError("fetch failed");
    }
    if (r.fail) throw new TypeError("fetch failed");
    if (r.hang) return new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
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
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://fixture-plumbing.ca/</loc></url></urlset>`;
/** A small home page with two links worth reading. */
const SIMPLE = `<html><head><title>Acme Plumbing</title><meta name="viewport" content="width=device-width"></head><body><p>${"We fix pipes. ".repeat(30)}</p><a href="/contact">Contact</a><a href="/services">Services</a></body></html>`;

const FORM = {
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
/** The likely problems drawn from the website (the rest come from the form, or from having no site). */
const WEBSITE_RULES = ["booking-by-hand", "no-way-to-ask", "unmeasured-visitors", "phone-unfriendly", "no-tap-to-call", "not-secure", "chat-without-booking"];
const BUILT = "2026-10-25T22:30:00.000Z";
const BUILT_WORDS = "2026-10-25 22:30 UTC";

async function main() {
  const url = await import("../lib/ai-audit/site-url");
  const checksMod = await import("../lib/ai-audit/site-checks");
  const fetchMod = await import("../lib/ai-audit/site-fetch");
  const briefMod = await import("../lib/ai-audit/brief");
  type SiteTarget = Extract<import("../lib/ai-audit/site-url").SiteTarget, { kind: "site" }>;
  type SiteReport = import("../lib/ai-audit/site-fetch").SiteReport;
  type Brief = ReturnType<typeof briefMod.assembleBrief>;
  const siteOf = (raw: string) => url.siteTarget(raw) as SiteTarget;
  const acme = siteOf("acme.ca");
  let clock = 0;
  const deps = (web: ReturnType<typeof fakeWeb>) => ({ fetch: web.fetch as never, clock: () => (clock += 10) });
  const page = (u: string, html: string, extra: Partial<import("../lib/ai-audit/site-checks").PageSnapshot> = {}) => ({ url: u, finalUrl: u, status: 200, contentType: "text/html", html, bytes: html.length, ms: 420, truncated: false, ...extra });
  /** The brief for a read, put together as buildBrief does. */
  const briefOf = (target: SiteTarget, r: SiteReport, form: Record<string, unknown> | null = null): Brief =>
    briefMod.assembleBrief({
      builtAt: BUILT,
      business: { name: "Acme", type: "local_service" },
      form: form ? { answers: form, at: null } : null,
      site: { target, checks: r.checks, pagesRead: r.pages.filter((p) => p.kind === "site_page" && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300).length, notes: r.notes, unread: r.unread },
    });
  /** A likely problem says no number: neither in what it says nor in how to test it. */
  const noDigits = (b: Brief) => {
    for (const h of b.hypotheses) {
      assert.ok(!/\d/.test(h.statement), `a number in: ${h.statement}`);
      assert.ok(!/\d/.test(h.test), `a number in the test: ${h.test}`);
    }
  };

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
  await check("names that point at a private address are refused, as the target and as a redirect hop (review 9a)", async () => {
    for (const bad of [
      "127.0.0.1.nip.io", "http://169.254.169.254.nip.io/latest/meta-data", "10.0.0.1.sslip.io", "app.xip.io", "localtest.me", "shop.lvh.me", "vcap.me",
      "a.traefik.me", "kubernetes.default.svc", "api.cluster.local", "nas.home.arpa", "printer.lan",
    ]) {
      assert.equal(url.siteTarget(bad).kind, "none", bad);
    }
    const hop = await fetchMod.readPage("https://acme.ca/", deps(fakeWeb({ "https://acme.ca/": { status: 302, location: "http://127.0.0.1.nip.io/admin" } })), { accept: "html", deadline: clock + 1_000_000 });
    assert.equal(hop.ok ? null : hop.error, "redirected_off_the_public_web");
  });
  await check("a lead who typed http:// is read over HTTPS first (review 3a)", () => {
    const typed = siteOf("http://acme.ca/about");
    assert.deepEqual([typed.start, typed.origin], ["https://acme.ca/", "https://acme.ca"]);
  });

  console.log("the checks");
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
  await check("600 KB of each shape that once took seconds is read well under a second (review 2)", () => {
    const CAP = 600_000;
    const fill = (unit: string) => unit.repeat(Math.ceil(CAP / unit.length)).slice(0, CAP);
    const shapes = [
      fill("connect.facebook.net/"), // the Meta Pixel signature, never completed (was 24.6 s)
      fill(`<a ${"a".repeat(3_990)}>`), // an attribute name as long as a tag may be (was 8 to 12 s)
      fill(`<meta ${"a".repeat(3_990)}>`), // the same, in the tag read three times a page
      fill(`<form ${"a".repeat(3_990)}>`),
      fill(`<a ${"b=c ".repeat(990)}d="x>`), // many attributes, the last quote never closed
      `gtag(${" ".repeat(CAP - 5)}`,
      fill(`GTM-${"A".repeat(100)}_`),
      fill(`cdn${"1".repeat(200)}`),
      fill('<script type="application/ld+json">'), // structured-data blocks never closed
    ];
    for (const html of shapes) {
      const started = performance.now();
      checksMod.runSiteChecks({ pages: [page("https://hostile.ca/", html)], https: { served: true, httpRedirects: null }, sitemap: null });
      checksMod.pagesToRead(page("https://hostile.ca/", html), () => true);
      checksMod.visibleText(html);
      const took = performance.now() - started;
      assert.ok(took < 500, `took ${took.toFixed(0)} ms on ${JSON.stringify(html.slice(0, 24))}`);
    }
  });
  await check("a page cut off at the size limit says unknown, never no, for what the part read does not show (review 4)", () => {
    // A heavy page builder's home page: the footer with the phone and social links is past 600 KB.
    const head = `<html><head><title>Acme</title><meta name="viewport" content="width=device-width"></head><body><p>${"We fix pipes. ".repeat(40)}</p><style>`;
    const html = (head + "a{b:c}".repeat(110_000)).slice(0, 600_000);
    const res = checksMod.runSiteChecks({ pages: [page("https://acme.ca/", html, { truncated: true, bytes: 600_000 })], https: { served: true, httpRedirects: true }, sitemap: null });
    const by = new Map(res.map((c) => [c.key, c]));
    for (const k of ["click_to_call", "email_link", "contact_form", "social_links", "meta_description"] as const) {
      assert.equal(by.get(k)?.status, "unknown", k);
      assert.equal(by.get(k)?.detail, "Not found in what was read, but only the first 600 KB of the home page was read, so it may be in the rest.");
    }
    assert.equal(by.get("title")?.status, "yes", "what was found is still found");
    assert.equal(by.get("mobile_viewport")?.status, "yes");
    assert.match(by.get("html_size")?.detail ?? "", /600 KB or more/);
    const b = briefMod.assembleBrief({ builtAt: BUILT, business: { name: "Acme", type: "local_service" }, form: null, site: { target: acme, checks: res, pagesRead: 1, notes: [] } });
    assert.ok(!b.facts.some((f) => f.id === "site:click_to_call" || f.id === "site:social_links"), "an absence in a cut-off page is not a fact");
    assert.ok(!b.hypotheses.some((h) => h.id === "no-tap-to-call"));
    assert.ok(b.gaps.some((g) => g.startsWith("Tap-to-call phone link: Not found in what was read")));
  });
  await check("a home page that did not load gives no checks: another page never stands in for it (review 4)", () => {
    const contact = `<html><head><title>Contact Acme</title></head><body>${"x ".repeat(200)}<a href="tel:+14165551234">call</a></body></html>`;
    assert.deepEqual(checksMod.runSiteChecks({ pages: [page("https://acme.ca/", SIMPLE, { status: 404 }), page("https://acme.ca/contact", contact)], https: { served: true, httpRedirects: true }, sitemap: null }), []);
    assert.deepEqual(checksMod.runSiteChecks({ pages: [], https: { served: false, httpRedirects: null }, sitemap: null }), [], "and nothing read says nothing, not even about HTTPS");
  });
  await check("a capital I with a dot before a link does not hide it: only A to Z are lowered (review 9d)", () => {
    const html = `<html><head><title>T</title></head><body><p>${String.fromCharCode(0x130).repeat(20)}</p><a href="tel:+14165551234">Call</a><p>${"word ".repeat(60)}</p></body></html>`;
    assert.equal(checksMod.asciiLower(html).length, html.length);
    const tel = checksMod.runSiteChecks({ pages: [page("https://acme.ca/", html)], https: { served: true, httpRedirects: true }, sitemap: null }).find((c) => c.key === "click_to_call");
    assert.equal(tel?.status, "yes", tel?.detail);
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
    const long = `<html><body><a href="/contact-${"a".repeat(600)}">Contact</a> <a href="/contact">Contact</a></body></html>`;
    assert.deepEqual(checksMod.pagesToRead(page("https://acme.ca/", long), () => true), ["https://acme.ca/contact"], "an address longer than 500 characters is not read");
  });
  await check("robots.txt: the sitemap is found and closed paths are respected", () => {
    const r = checksMod.readRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nDisallow: /*.php$\nSitemap: https://fixture-plumbing.ca/sitemap.xml\n");
    assert.deepEqual(r, { sitemaps: ["https://fixture-plumbing.ca/sitemap.xml"], allow: [], disallow: ["/private/", "/*.php$"] });
    assert.equal(checksMod.robotsAllow("/private/area", r), false);
    assert.equal(checksMod.robotsAllow("/index.php", r), false);
    assert.equal(checksMod.robotsAllow("/index.php?x=1", r), true);
    assert.equal(checksMod.robotsAllow("/contact/", r), true);
  });
  await check("robots.txt groups as RFC 9309 reads them: shared user-agent lines, our own group, Allow, the query (review 5)", () => {
    const allow = (text: string, path: string) => checksMod.robotsAllow(path, checksMod.readRobots(text));
    assert.equal(allow("User-agent: *\nUser-agent: Googlebot\nDisallow: /contact\n", "/contact"), false, "consecutive user-agent lines share one group");
    const ours = "User-agent: *\nDisallow: /\n\nUser-agent: OASIS-AI-Audit\nDisallow: /private\n";
    assert.deepEqual([allow(ours, "/"), allow(ours, "/private/x")], [true, false], "the group naming us is the one we follow");
    assert.equal(allow("User-agent: oasis-ai-audit/1.0\nDisallow: /x\n", "/x"), false, "matched without case, version or comment");
    assert.equal(allow("User-agent: OASIS-AI-Audit\nDisallow: /a\n\nUser-agent: OASIS-AI-Audit\nDisallow: /b\n", "/b"), false, "two groups for us are one");
    assert.equal(allow("User-agent: *\nAllow: /contact\nDisallow: /\n", "/contact"), true, "the longer rule wins");
    assert.equal(allow("User-agent: *\nAllow: /contact\nDisallow: /\n", "/about"), false);
    assert.equal(allow("User-agent: *\nAllow: /page\nDisallow: /page\n", "/page"), true, "a tie goes to Allow");
    assert.equal(allow("User-agent: *\nDisallow: /*?\n", "/contact?ref=1"), false, "the query is matched too");
    assert.equal(allow("User-agent: *\nDisallow: /*?\n", "/contact"), true);
    assert.equal(allow("Disallow: /\nUser-agent: *\nDisallow:\n", "/anything"), true, "a rule outside any group, and an empty Disallow, close nothing");
    assert.equal(allow(`${String.fromCharCode(0xfeff)}User-agent: *\nDisallow: /x\n`, "/x"), false, "a byte-order mark does not hide the first group");
    assert.deepEqual(checksMod.readRobots(`Sitemap: https://acme.ca/${"s".repeat(600)}\nSitemap: https://acme.ca/sm.xml\n`).sitemaps, ["https://acme.ca/sm.xml"], "a sitemap address too long to be one is skipped (review 9b)");
  });
  await check("a robots.txt rule is matched with no pattern: * is any run of characters, a final $ anchors the end (review 1)", () => {
    const m = checksMod.robotsMatch;
    for (const [path, rule, want] of [
      ["/fish", "/fish", true], ["/fish.html", "/fish", true], ["/fish/salmon.html", "/fish", true], ["/Fish.asp", "/fish", false], ["/catfish", "/fish", false],
      ["/fish/", "/fish*", true], ["/fish/?id=x", "/fish/", true], ["/fish", "/fish/", false],
      ["/index.php", "/*.php", true], ["/folder/filename.php?parameters", "/*.php", true], ["/folder/any.php.file.html", "/*.php", true], ["/windows.PHP", "/*.php", false],
      ["/filename.php", "/*.php$", true], ["/filename.php?parameters", "/*.php$", false], ["/filename.php5", "/*.php$", false],
      ["/fishheads/catfish.php?parameters", "/fish*.php", true], ["/Fish.PHP", "/fish*.php", false],
      ["/", "/$", true], ["/a", "/$", false], ["/abab", "/*ab*ab$", true], ["/aba", "/*ab*ba$", false], ["/anything", "*", true],
    ] as const) {
      assert.equal(m(path, rule), want, `${rule} on ${path}`);
    }
  });
  await check("robots.txt rules are matched in linear time: the rule that ran past a minute takes a moment (review 1)", () => {
    const nine = checksMod.readRobots(`User-agent: *\nDisallow: /${"*a".repeat(9)}*b\n`);
    let started = performance.now();
    assert.equal(checksMod.robotsAllow(`/contact-${"a".repeat(490)}`, nine), true);
    assert.ok(performance.now() - started < 50, `took ${(performance.now() - started).toFixed(0)} ms`);
    // 600 KB of such rules, each against ten long paths.
    const files = [
      `User-agent: *\n${Array.from({ length: 2_000 }, (_, i) => `Disallow: /${"*a".repeat(150)}*b${i}`).join("\n")}`.slice(0, 600_000),
      `User-agent: *\n${Array.from({ length: 1_999 }, () => `Disallow: /*${"a".repeat(250)}b*`).join("\n")}`,
      `User-agent: *\n${Array.from({ length: 1_999 }, (_, i) => `${i % 2 ? "Allow" : "Disallow"}: /${"*ab".repeat(20)}$`).join("\n")}`,
    ];
    for (const text of files) {
      started = performance.now();
      const rules = checksMod.readRobots(text);
      for (let i = 0; i < 10; i++) checksMod.robotsAllow(`/${"ab".repeat(249)}`, rules);
      const took = performance.now() - started;
      assert.ok(took < 500, `took ${took.toFixed(0)} ms on ${JSON.stringify(text.slice(14, 40))}`);
    }
  });

  console.log("reading a site");
  const site = url.siteTarget("fixture-plumbing.ca") as SiteTarget;
  const ROUTES: Record<string, Route> = {
    "https://fixture-plumbing.ca/": { body: HOME },
    "http://fixture-plumbing.ca/": { status: 301, location: "https://fixture-plumbing.ca/" },
    "https://fixture-plumbing.ca/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /private/\nSitemap: https://fixture-plumbing.ca/sitemap.xml\n" },
    "https://fixture-plumbing.ca/sitemap.xml": { type: "application/xml", body: SITEMAP },
    "https://fixture-plumbing.ca/contact/": { body: CONTACT },
    "https://fixture-plumbing.ca/book": { body: BOOK },
    "https://fixture-plumbing.ca/services": { status: 302, location: "/services/" },
    "https://fixture-plumbing.ca/services/": { body: "<html><title>Services</title><body>Drains</body></html>" },
    "https://fixture-plumbing.ca/pricing": { type: "application/pdf", body: "%PDF" },
    "https://fixture-plumbing.ca/about": { status: 302, location: "http://127.0.0.1/admin" },
  };
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
    assert.equal(by.get("sitemap")?.evidence?.url, "https://fixture-plumbing.ca/sitemap.xml");
    assert.equal(by.get("https")?.detail, "The site answers on a secure HTTPS address.");
    assert.equal(r.pages.find((p) => p.url === "https://fixture-plumbing.ca/services")?.finalUrl, "https://fixture-plumbing.ca/services/", "a same-site redirect is followed");
    assert.equal(web.seen[0].url, "https://fixture-plumbing.ca/robots.txt", "robots.txt comes first");
  });
  await check("a site that only answers on plain HTTP is read there and reported; a redirect loop stops at five", async () => {
    const web = fakeWeb({ "http://fixture-plumbing.ca/": { body: HOME } });
    const r = await fetchMod.readSite(site, deps(web));
    const https = r.checks.find((c) => c.key === "https");
    assert.equal(https?.status, "no");
    assert.equal(https?.detail, "The site could not be reached on a secure HTTPS address; it was read over plain HTTP.");
    assert.equal(https?.evidence?.url, "https://fixture-plumbing.ca/robots.txt", "the secure request that failed is the evidence");
    const loop: Record<string, Route> = {};
    for (let i = 0; i < 10; i++) loop[`https://loop.ca/${i ? `p${i}` : ""}`] = { status: 302, location: `https://loop.ca/p${i + 1}` };
    const looped = await fetchMod.readPage("https://loop.ca/", deps(fakeWeb(loop)), { accept: "html", deadline: clock + 1_000_000 });
    assert.deepEqual(looped.ok ? null : looped.error, "too_many_redirects");
  });
  await check("a lead who typed http:// is asked over HTTPS, and no HTTPS is not said when it answers there (review 3a)", async () => {
    const typed = siteOf("http://acme.ca");
    const web = fakeWeb({ "https://acme.ca/": { body: SIMPLE }, "http://acme.ca/": { body: SIMPLE } });
    const r = await fetchMod.readSite(typed, deps(web));
    assert.equal(web.seen[0].url, "https://acme.ca/robots.txt", "the first request is over HTTPS");
    const https = r.checks.find((c) => c.key === "https");
    assert.equal(https?.status, "yes");
    assert.equal(https?.detail, "The site answers on HTTPS, but its plain http:// address does not send visitors there.");
    assert.ok(!briefOf(typed, r).hypotheses.some((h) => h.id === "not-secure"));
  });
  await check("a page is read up to the size cap; the time budget stops what is left", async () => {
    const big = `<html><title>Big</title><body>${"x".repeat(fetchMod.MAX_PAGE_BYTES + 50_000)}</body></html>`;
    const r = await fetchMod.readPage("https://big.ca/", deps(fakeWeb({ "https://big.ca/": { body: big } })), { accept: "html", deadline: clock + 1_000_000 });
    assert.ok(r.ok && r.page.truncated && r.page.bytes === fetchMod.MAX_PAGE_BYTES);
    const late = await fetchMod.readPage("https://big.ca/", deps(fakeWeb({})), { accept: "html", deadline: clock - 1 });
    assert.deepEqual(late.ok ? null : late.error, "out_of_time");
  });
  await check("a page left unread for lack of time says so, never that its robots.txt could not be read", async () => {
    // The time runs out right after the home page, which links to a page on www. (another host, whose robots.txt is not read yet).
    let late = false;
    const web = fakeWeb({ "https://acme.ca/": { body: `<html><head><title>Acme</title></head><body>${"x ".repeat(200)}<a href="https://www.acme.ca/contact">Contact</a></body></html>` } });
    const d = {
      fetch: (async (u: string, init: Parameters<typeof web.fetch>[1]) => {
        if (u === "https://acme.ca/") late = true;
        return web.fetch(u, init);
      }) as never,
      clock: () => (late ? fetchMod.TOTAL_BUDGET_MS + 1 : 0),
    };
    const r = await fetchMod.readSite(acme, d);
    assert.ok(r.notes.includes("https://www.acme.ca/contact was not read: the time for reading the site ran out."), r.notes.join(" | "));
    assert.ok(!r.notes.some((n) => n.includes("robots.txt could not be read")));
    assert.ok(!web.seen.some((s) => s.url.startsWith("https://www.acme.ca/")), "nothing is asked for once the time is up");
  });
  await check("a site that is down or answers with errors gives one gap, with the time, and nothing else about it (review 3b)", async () => {
    const cases: Array<[string, Record<string, Route>, SiteReport["unread"]]> = [
      ["down", {}, "no_answer"],
      ["503 everywhere", { "https://acme.ca/robots.txt": { status: 503, body: "Back soon" }, "https://acme.ca/": { status: 503, body: "<html><title>Back soon</title></html>" }, "http://acme.ca/": { status: 503, body: "Back soon" } }, "not_allowed"],
      ["home page 503", { "https://acme.ca/": { status: 503, body: "<html><title>Back soon</title></html>" } }, "home_page_failed"],
    ];
    for (const [label, routes, unread] of cases) {
      const r = await fetchMod.readSite(acme, deps(fakeWeb(routes)));
      assert.equal(r.unread, unread, label);
      assert.deepEqual(r.checks, [], `${label}: no checks`);
      const b = briefOf(acme, r, FORM);
      assert.ok(!b.facts.some((f) => f.source.kind === "site"), `${label}: no website fact`);
      assert.ok(!b.hypotheses.some((h) => WEBSITE_RULES.includes(h.id)), `${label}: no website hypothesis`);
      assert.ok(b.hypotheses.some((h) => h.id === "shelfware"), `${label}: the form's likely problems are still there`);
      if (unread === "no_answer") assert.deepEqual(b.gaps, [`The site did not answer when we checked at ${BUILT_WORDS}; check it before the call.`], `${label}: one line`);
      else assert.equal(b.gaps[b.gaps.length - 1], `Nothing on the site was read when we checked at ${BUILT_WORDS}, for the reason above; look at it by hand before the call.`, `${label}: ${b.gaps.join(" | ")}`);
    }
  });
  await check("a home page that answers 404 is a gap: nothing past it is read, and no page stands in for it (review 4)", async () => {
    const web = fakeWeb({
      "https://acme.ca/": { status: 404, body: SIMPLE },
      "https://acme.ca/contact": { body: `<html><head><title>Contact Acme</title></head><body>${"x ".repeat(200)}<a href="tel:+14165551234">call</a></body></html>` },
    });
    const r = await fetchMod.readSite(acme, deps(web));
    assert.equal(r.unread, "home_page_failed");
    assert.ok(!web.seen.some((s) => s.url === "https://acme.ca/contact"));
    const b = briefOf(acme, r);
    assert.ok(!b.facts.some((f) => f.source.kind === "site"));
    assert.ok(b.gaps.includes("https://acme.ca/ answered with HTTP 404, so nothing on the site was read."), b.gaps.join(" | "));
  });
  await check("robots.txt is read first and obeyed for every request, the home page and the sitemap included (review 5)", async () => {
    const shut = fakeWeb({ "https://acme.ca/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /\n" }, "https://acme.ca/": { body: SIMPLE }, "https://acme.ca/sitemap.xml": { type: "application/xml", body: SITEMAP } });
    const r1 = await fetchMod.readSite(acme, deps(shut));
    assert.deepEqual(shut.seen.map((s) => s.url), ["https://acme.ca/robots.txt"], "Disallow: / closes the home page and /sitemap.xml too");
    assert.equal(r1.unread, "not_allowed");
    assert.ok(r1.notes.includes("https://acme.ca/ was not read: the site's robots.txt asks robots not to."), r1.notes.join(" | "));
    assert.ok(briefOf(acme, r1).gaps.some((g) => g.startsWith("Nothing on the site was read when we checked at")));

    const ours = fakeWeb({
      "https://acme.ca/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /\n\nUser-agent: OASIS-AI-Audit\nAllow: /$\nAllow: /contact\nDisallow: /\n" },
      "https://acme.ca/": { body: SIMPLE },
      "https://acme.ca/contact": { body: CONTACT },
    });
    const r2 = await fetchMod.readSite(acme, deps(ours));
    assert.equal(r2.unread, null);
    assert.ok(ours.seen.some((s) => s.url === "https://acme.ca/contact"), "our group's Allow opens it");
    assert.ok(!ours.seen.some((s) => s.url === "https://acme.ca/services" || s.url === "https://acme.ca/sitemap.xml"), "and nothing else");
    assert.equal(r2.checks.find((c) => c.key === "sitemap")?.status, "unknown", "a sitemap robots.txt closes is not known, not missing");

    const sick = fakeWeb({ "https://acme.ca/robots.txt": { status: 503, body: "Service Unavailable" }, "https://acme.ca/": { body: SIMPLE } });
    const r3 = await fetchMod.readSite(acme, deps(sick));
    assert.deepEqual(sick.seen.map((s) => s.url), ["https://acme.ca/robots.txt"], "a robots.txt that answers 5xx closes the site");
    assert.ok(r3.notes.some((n) => n.includes("answered with HTTP 503") && n.includes("RFC 9309")), r3.notes.join(" | "));
    const timedOut = fakeWeb({ "https://acme.ca/robots.txt": { fail: true }, "https://acme.ca/": { body: SIMPLE } });
    const r4 = await fetchMod.readSite(acme, deps(timedOut));
    assert.ok(!timedOut.seen.some((s) => s.url === "https://acme.ca/"), "as does one that cannot be reached");
    assert.equal(r4.unread, "no_answer");
    assert.equal((await fetchMod.readSite(acme, deps(fakeWeb({ "https://acme.ca/": { body: SIMPLE } })))).unread, null, "a robots.txt that answers 404 means no rules");

    const query = fakeWeb({ "https://acme.ca/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /*?\n" }, "https://acme.ca/": { body: SIMPLE.replace('href="/contact"', 'href="/contact?ref=1"') }, "https://acme.ca/contact?ref=1": { body: CONTACT } });
    const r5 = await fetchMod.readSite(acme, deps(query));
    assert.ok(!query.seen.some((s) => s.url.includes("?ref=1")), "a query robots.txt closes is never fetched");
    assert.ok(r5.notes.some((n) => n.includes("/contact?ref=1") && n.includes("robots.txt")));
  });
  await check("a sitemap is said to be there only once it was read; a failed read is a gap, never an absence (review 6)", async () => {
    const sitemapCheck = async (web: ReturnType<typeof fakeWeb>, d = deps(web)) => (await fetchMod.readSite(acme, d)).checks.find((c) => c.key === "sitemap");
    const ghost = fakeWeb({ "https://acme.ca/robots.txt": { type: "text/plain", body: "Sitemap: https://acme.ca/ghost-sitemap.xml\n" }, "https://acme.ca/": { body: SIMPLE } });
    const g = await sitemapCheck(ghost);
    assert.equal(g?.status, "no");
    assert.equal(g?.detail, "robots.txt names a sitemap at https://acme.ca/ghost-sitemap.xml, but it is not there, and there is none at /sitemap.xml.");
    assert.ok(ghost.seen.some((s) => s.url === "https://acme.ca/ghost-sitemap.xml"), "the named sitemap is fetched before anything is said");
    const real = await sitemapCheck(fakeWeb({ "https://acme.ca/robots.txt": { type: "text/plain", body: "Sitemap: /sm.xml\n" }, "https://acme.ca/": { body: SIMPLE }, "https://acme.ca/sm.xml": { type: "application/xml", body: SITEMAP } }));
    assert.deepEqual([real?.status, real?.evidence?.url], ["yes", "https://acme.ca/sm.xml"]);
    const away = await sitemapCheck(fakeWeb({ "https://acme.ca/robots.txt": { type: "text/plain", body: "Sitemap: https://cdn.example-host.com/acme.xml\n" }, "https://acme.ca/": { body: SIMPLE } }));
    assert.equal(away?.status, "unknown", "one on another site is not read, so it is not known");
    const reset = await sitemapCheck(fakeWeb({ "https://acme.ca/": { body: SIMPLE }, "https://acme.ca/sitemap.xml": { fail: true } }));
    assert.deepEqual([reset?.status, reset?.detail], ["unknown", "https://acme.ca/sitemap.xml could not be reached, so whether the site has a sitemap there is not known."]);
    // /sitemap.xml that does not answer in time: every request after the home page has 10 ms left.
    let late = false;
    const slow = fakeWeb({ "https://acme.ca/": { body: SIMPLE }, "https://acme.ca/sitemap.xml": { hang: true } });
    const slowDeps = {
      fetch: (async (u: string, init: Parameters<typeof slow.fetch>[1]) => {
        if (u === "https://acme.ca/") late = true;
        return slow.fetch(u, init);
      }) as never,
      clock: () => (late ? fetchMod.TOTAL_BUDGET_MS - 10 : 0),
    };
    const timed = await sitemapCheck(slow, slowDeps);
    assert.deepEqual([timed?.status, timed?.detail], ["unknown", "https://acme.ca/sitemap.xml did not answer within 8 seconds, so whether the site has a sitemap there is not known."]);
  });
  await check("a hostile robots.txt and a link built for it are read in a moment (the read that did not finish in a minute; review 1)", async () => {
    const web = fakeWeb({
      "https://acme.ca/robots.txt": { type: "text/plain", body: `User-agent: *\nDisallow: /${"*a".repeat(9)}*b\n` },
      "https://acme.ca/": { body: `<html><head><title>Acme</title></head><body>${"x ".repeat(200)}<a href="/contact-${"a".repeat(470)}">Contact</a></body></html>` },
    });
    const started = performance.now();
    await fetchMod.readSite(acme, deps(web));
    const took = performance.now() - started;
    assert.ok(took < 500, `took ${took.toFixed(0)} ms`);
    assert.ok(web.seen.some((s) => s.url.startsWith("https://acme.ca/contact-")), "the rule does not match it, so it is read");
  });
  await check("a sitemap address of 590 KB is skipped, so the brief stays small (review 9b)", async () => {
    const huge = fakeWeb({ "https://acme.ca/robots.txt": { type: "text/plain", body: `User-agent: *\nSitemap: https://acme.ca/${"s".repeat(590_000)}\n` }, "https://acme.ca/": { body: SIMPLE } });
    const r = await fetchMod.readSite(acme, deps(huge));
    assert.ok(JSON.stringify(briefOf(acme, r)).length < 20_000);
    assert.ok(huge.seen.every((s) => s.url.length < 600));
  });

  console.log("the brief");
  const noBookingChecks = checksMod.runSiteChecks({
    pages: [page("https://fixture-plumbing.ca/", HOME.replace(/<a href="\/book">Book a visit<\/a>/, "").replace(/<script async src="https:\/\/www.googletagmanager[^<]*<\/script>/, ""))],
    https: { served: true, httpRedirects: true },
    sitemap: { found: false, url: null },
  });
  await check("the brief labels the website's checks Verified and the form's answers Client-reported", () => {
    const b = briefMod.assembleBrief({ builtAt: NOW().toISOString(), business: { name: "Fixture Plumbing", type: "local_service" }, form: { answers: FORM, at: null }, site: { target: site, checks: noBookingChecks, pagesRead: 1, notes: [] } });
    assert.ok(b.facts.filter((f) => f.source.kind === "site").every((f) => f.label === "verified"));
    assert.ok(b.facts.filter((f) => f.source.kind === "form").every((f) => f.label === "client_reported"));
    const revenue = b.facts.find((f) => f.id === "form:monthly_revenue");
    assert.match(revenue?.statement ?? "", /\$50K/, "the option's own words, never a figure of ours");
    assert.ok(b.facts.some((f) => f.id === "form:bottleneck_detail" && f.statement.includes("We miss calls")));
    assert.ok(b.confirm.some((c) => c.question_id === "tech-tools" && c.statement.includes("Jobber")));
  });
  await check("likely problems need evidence, carry no number of their own, and say how to test them", () => {
    const b = briefMod.assembleBrief({ builtAt: NOW().toISOString(), business: { name: "Fixture Plumbing", type: "local_service" }, form: { answers: FORM, at: null }, site: { target: site, checks: noBookingChecks, pagesRead: 1, notes: [] } });
    const ids = b.hypotheses.map((h) => h.id);
    assert.ok(ids.includes("booking-by-hand"), ids.join(","));
    assert.ok(ids.includes("unmeasured-visitors"));
    assert.ok(ids.includes("shelfware"), "from the form: tools nobody uses");
    // Only the home page was read here, and it has no form or chat: the brief says what it saw.
    assert.ok(ids.includes("no-way-to-ask"));
    noDigits(b);
    for (const h of b.hypotheses) assert.ok(h.test.length > 10 && h.questions.length > 0);
    assert.deepEqual(b.weight.slice(0, 4).map((w) => w.question_id), ["sales-sources", "sales-handling", "sales-conversion", "sales-lost"], "their own goal first");
    assert.ok(b.weight.length <= 6);
  });
  await check("every likely problem the rules can raise carries no number, in what it says or in how to test it", () => {
    const seen = new Set<string>();
    const add = (b: Brief) => {
      noDigits(b);
      for (const h of b.hypotheses) seen.add(h.id);
    };
    const shop = `<html><head><title>Old Shop</title></head><body><p>${"We sell things. ".repeat(30)}</p><script src="https://embed.tawk.to/abc"></script></body></html>`;
    const withChat = checksMod.runSiteChecks({ pages: [page("http://old-shop.ca/", shop)], https: { served: false, httpRedirects: null }, sitemap: null });
    const noChat = checksMod.runSiteChecks({ pages: [page("http://old-shop.ca/", shop.replace(/<script[^>]*><\/script>/, ""))], https: { served: false, httpRedirects: null }, sitemap: null });
    for (const tried of ["hired", "tools", "diy"]) {
      for (const checks of [withChat, noChat]) {
        add(briefMod.assembleBrief({ builtAt: BUILT, business: { name: "Old Shop", type: "local_service" }, form: { answers: { ...FORM, tried_before: tried }, at: null }, site: { target: siteOf("old-shop.ca"), checks, pagesRead: 1, notes: [] } }));
      }
    }
    add(briefMod.assembleBrief({ builtAt: BUILT, business: { name: "Insta Co", type: "local_service" }, form: null, site: { target: url.siteTarget("instagram.com/instaco"), checks: [], pagesRead: 0, notes: [] } }));
    assert.deepEqual([...seen].sort(), ["booking-by-hand", "chat-without-booking", "half-built", "no-own-site", "no-tap-to-call", "no-way-to-ask", "not-secure", "past-vendor", "phone-unfriendly", "shelfware", "unmeasured-visitors"]);
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
  for (const f of ["bravo__186_os_approvals.sql", "bravo__206_tool_jobs.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql"]) await apply(db, f);
  const store = await import("../lib/ai-audit/store");
  const lifecycle = await import("../lib/ai-audit/lifecycle");
  const briefs = await import("../lib/ai-audit/briefs");
  const tick = await import("../lib/ai-audit/tick");
  const view = await import("../lib/ai-audit/view");
  const route = await import("../app/api/ai-audit/[engagementId]/route");
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
  const post = (eid: string, body: Record<string, unknown>) => {
    const u = `http://t.test/api/ai-audit/${eid}`;
    const r = new Request(u, { method: "POST", headers: { "content-type": "application/json", origin: "http://t.test" }, body: JSON.stringify(body) }) as Request & { nextUrl: URL };
    Object.defineProperty(r, "nextUrl", { value: new URL(u) });
    return route.POST(r as never, { params: Promise.resolve({ engagementId: eid }) });
  };
  const tickDeps = () => ({ payment: { alert: async () => undefined } as never, onboarding: {} as never, site: deps(fakeWeb({})) });

  await check("without bravo__241 only the brief stops: the audit's guard passes, the tick runs its other steps, the pages show no brief (review 8)", async () => {
    assert.equal(await store.aiAuditTablesInstalled(db), true, "237 to 239 are the audit's guard; 241 is not part of it");
    assert.equal(await briefs.briefTablesInstalled(db), false);
    const eid = await openWith(10, null, FORM);
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps() });
    assert.equal(rep.tenants, 1);
    assert.deepEqual(rep.errors.map((e) => e.step), ["briefs"], "the brief step says so, and nothing else fails");
    assert.match(rep.errors[0].error, /bravo__241/);
    assert.deepEqual(await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: deps(fakeWeb({})) }), { ok: false, error: "not_installed" });
    assert.equal((await view.engagementView(db, OASIS, eid, NOW()))?.brief, null, "the engagement page still opens, without a brief");
    await login(USERS.admin);
    const res = await post(eid, { action: "build_brief" });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error?: string }).error, "brief_not_installed");
    await login(null);
  });
  await apply(db, "bravo__241_ai_audit_briefs.sql");

  await check("a brief is stored as a version with one source per request and one for the form; it never changes", async () => {
    const eid = await openWith(1, "fixture-plumbing.ca", FORM);
    const web = fakeWeb(ROUTES);
    const r = await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: deps(web) });
    assert.ok(r.ok && r.created, !r.ok ? r.error : "");
    const b = r.ok ? r.brief : (null as never);
    assert.equal(b.version_no, 1);
    assert.equal(b.status, "partial", "some pages could not be read, so it says so");
    const sources = await db.execute({ sql: "SELECT kind, url, final_url, reliability, content_sha256, excerpt FROM ai_audit_sources WHERE tenant_id = ? AND brief_id = ? ORDER BY kind, url", args: [OASIS, b.id] });
    assert.ok(sources.rows.some((s) => String(s.kind) === "form_answers" && String(s.reliability) === "client_stated"));
    const pages = sources.rows.filter((s) => String(s.kind) === "site_page");
    assert.ok(pages.length >= 4);
    // robots.txt, the sitemap and the plain-HTTP check are sources too (review 6).
    assert.deepEqual([...new Set(sources.rows.map((s) => String(s.kind)))].sort(), ["form_answers", "http_check", "robots_txt", "site_page", "sitemap"]);
    assert.ok(sources.rows.filter((s) => String(s.kind) !== "form_answers").every((s) => String(s.reliability) === "own_measurement"));
    const read = new Set(sources.rows.flatMap((s) => [String(s.url), String(s.final_url)]));
    for (const f of b.content.facts.filter((x) => x.source.kind === "site")) {
      assert.ok(f.source.kind === "site" && f.source.url && read.has(f.source.url), `a Verified fact without a stored source: ${f.statement}`);
    }
    assert.ok(!sources.rows.some((s) => String(s.excerpt ?? "").includes("<html")), "excerpts, never pages");
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_briefs SET status = 'ready' WHERE id = ?", args: [b.id] }), /frozen/);
    const again = await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: deps(fakeWeb(ROUTES)) });
    assert.deepEqual(again, { ok: false, error: "too_soon" });
    const later = await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: new Date(Date.now() + 120_000), deps: deps(fakeWeb(ROUTES)) });
    assert.ok(later.ok && later.brief.version_no === 2);
  });
  await check("the tick builds the first brief once the call is booked, and only once", async () => {
    const eid = await openWith(2, null, FORM);
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "call_scheduled", actor: cc, now: NOW() })).ok);
    assert.ok((await briefs.dueBriefs(db, OASIS)).includes(eid));
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], deps: tickDeps() });
    assert.ok(rep.briefsBuilt >= 1, JSON.stringify(rep.errors));
    const b = await briefs.latestBrief(db, OASIS, eid);
    assert.ok(b && b.content.site.kind === "none" && b.content.gaps.includes("The lead has no website on file."));
    assert.ok(!(await briefs.dueBriefs(db, OASIS)).includes(eid));
  });
  await check("after Gate 1 no brief is built; the route builds one for a founder and refuses a quick second press", async () => {
    const eid = await openWith(3, null, FORM);
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'generating' WHERE id = ?", args: [eid] });
    assert.deepEqual(await briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: deps(fakeWeb({})) }), { ok: false, error: "stage_closed" });
    const fresh = await openWith(4, null, null);
    await login(USERS.admin);
    const built = await post(fresh, { action: "build_brief" });
    assert.equal(built.status, 200, JSON.stringify(await built.clone().json()));
    const second = await post(fresh, { action: "build_brief" });
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error?: string }).error, "brief_too_soon");
    await login(null);
  });
  await check("two builds at once store one brief: the one that loses the insert answers with the winner's (review 9c)", async () => {
    const eid = await openWith(7, "fixture-plumbing.ca", FORM);
    // Each build's first request waits until both have made theirs: both have passed the
    // "too soon" check by then, and both go on to store version 1.
    const base = fakeWeb(ROUTES);
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const gated = async (u: string, init: Parameters<typeof base.fetch>[1]) => {
      if (arrived < 2 && u === "https://fixture-plumbing.ca/robots.txt") {
        arrived += 1;
        if (arrived === 2) release();
        await both;
      }
      return base.fetch(u, init);
    };
    const d = { fetch: gated as never, clock: () => (clock += 10) };
    const [a, b] = await Promise.all([0, 1].map(() => briefs.buildBrief(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), deps: d })));
    assert.ok(a.ok && b.ok, JSON.stringify([a, b].map((x) => (x.ok ? x.created : x.error))));
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    assert.equal(a.brief.id, b.brief.id);
    const n = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_briefs WHERE tenant_id = ? AND engagement_id = ?", args: [OASIS, eid] });
    assert.equal(Number(n.rows[0].n), 1);
    const built = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_events WHERE tenant_id = ? AND engagement_id = ? AND event = 'brief_built'", args: [OASIS, eid] });
    assert.equal(Number(built.rows[0].n), 1, "the loser stored nothing");
  });
  await check("the tick tries each engagement on its own: one whose brief fails does not hold up the next, and waits before its next try (review 7)", async () => {
    const failing = await openWith(8, null, FORM);
    const fine = await openWith(9, null, FORM);
    for (const id of [failing, fine]) assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: id, to: "call_scheduled", actor: cc, now: NOW() })).ok);
    assert.deepEqual(new Set(await briefs.dueBriefs(db, OASIS)), new Set([failing, fine]));
    // Storing this one engagement's brief fails: a stand-in for any error in a build.
    await db.execute(`CREATE TRIGGER test_brief_fails BEFORE INSERT ON ai_audit_briefs WHEN NEW.engagement_id = '${failing}' BEGIN SELECT RAISE(ABORT, 'test: storing this brief fails'); END`);
    const t0 = Date.now();
    const at = (minutes: number) => () => new Date(t0 + minutes * 60_000);
    const events = async (event: string) => Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_events WHERE tenant_id = ? AND engagement_id = ? AND event = ?", args: [OASIS, failing, event] })).rows[0].n);

    const first = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: at(0), deps: tickDeps() });
    assert.deepEqual(first.errors.map((e) => [e.step, e.engagementId]), [["brief", failing]], JSON.stringify(first.errors));
    assert.equal(first.briefsBuilt, 1, "the next engagement is built in the same run");
    assert.ok(await briefs.latestBrief(db, OASIS, fine));
    assert.deepEqual([await events("brief_attempt"), await events("brief_failed")], [1, 1], "the try is marked before it starts, and the failure kept");
    assert.deepEqual(await briefs.dueBriefs(db, OASIS, 2, at(1)()), [], "a failed try waits before the next");
    assert.deepEqual(await briefs.dueBriefs(db, OASIS, 2, at(31)()), [failing]);
    await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: at(31), deps: tickDeps() });
    await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: at(62), deps: tickDeps() });
    assert.equal(await events("brief_attempt"), briefs.BRIEF_MAX_TICK_ATTEMPTS);
    assert.deepEqual(await briefs.dueBriefs(db, OASIS, 2, at(200)()), [], "after three tries it is left to the button");
    await db.execute("DROP TRIGGER test_brief_fails");
    const pressed = await briefs.buildBrief(db, { tenantId: OASIS, engagementId: failing, actor: cc, now: at(201)(), deps: deps(fakeWeb({})) });
    assert.ok(pressed.ok && pressed.created, "the button still builds it");
  });

  console.log("the pages");
  await check("the brief panel wraps long addresses and words on a phone (review 9e)", () => {
    const src = readFileSync(join(process.cwd(), "components", "ai-audit", "workspace", "BriefPanel.tsx"), "utf8");
    assert.match(src, /<li key=\{g\} className="min-w-0 break-words">/, "the lines under Could not check");
    assert.equal(src.match(/<span className="min-w-0 break-words text-fg">\{f\.statement\}<\/span>/g)?.length, 2, "the facts from the website and from the form");
  });

  finish("ai-audit-brief");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
