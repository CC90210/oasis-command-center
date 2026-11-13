/**
 * tests/site-scan-browser-read.test.ts - a site that turns the Worker away is read by the runner's
 * real browser (lib/site-scan/browser-read.ts, run.ts browserRead, POST scan-pages), against the
 * real migrations in a local libSQL file. No network.
 *
 * CC, 2026-11-13: mandymanagement.com answered the Worker with HTTP 403 and mountainelectric.ca's
 * robots.txt never answered it, so both reports were empty, while both sites answer an ordinary
 * connection at once.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-browser-read.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { ENV, OASIS, answerOf, applyMigrationFile, check, finish, seedRunner, setupToolsDatabase, signedRequest } from "./_tools-harness";

const ROOT = join(__dirname, "..");
const LEASE = "e".repeat(32);
const SITE = "https://bayside-plumbing.ca";

const HOME = `<!doctype html><html lang="en"><head><title>Bayside Plumbing | Emergency plumbers in Barrie</title>
<meta name="description" content="Licensed plumbers for drains, water heaters and leaks in Barrie, Ontario."></head><body>
<nav><a href="/services">Services</a><a href="/contact">Contact us</a><a href="/about">About</a></nav>
<h1>Plumbing repairs the same day</h1><p>Call us at 705-555-0142 for drains, water heaters and burst pipes across Barrie and Innisfil.</p>
<a href="/contact">Book a plumber</a><footer>Copyright 2026 Bayside Plumbing Ltd.</footer></body></html>`;
const PAGE = (title: string) =>
  `<!doctype html><html><head><title>${title} | Bayside Plumbing</title></head><body><h1>${title}</h1><p>Drain cleaning, water heater installs and leak repair. Phone 705-555-0142.</p><form><input name="email"></form></body></html>`;

/** The Worker's view: robots.txt answers, every page is refused (a host that blocks Cloudflare's network). */
function refusingSite(robots = "User-agent: *\nAllow: /\n") {
  return async (url: string) => {
    if (url.endsWith("/robots.txt")) return new Response(robots, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("Forbidden", { status: 403, headers: { "content-type": "text/html" } });
  };
}

/** What the runner's browser saw at each address. */
function browserPage(url: string): Record<string, unknown> {
  const path = new URL(url).pathname;
  if (url.startsWith("http://")) return { url, status: 301, location: url.replace("http://", "https://"), content_type: "text/html", body: "", ms: 40 };
  if (path === "/robots.txt") return { url, status: 200, content_type: "text/plain", body: "User-agent: *\nAllow: /\n", ms: 30 };
  if (path === "/sitemap.xml") return { url, status: 404, content_type: "text/html", body: "Not found", ms: 30 };
  if (path === "/") return { url, status: 200, content_type: "text/html", body: HOME, ms: 420 };
  return { url, status: 200, content_type: "text/html", body: PAGE(path.slice(1)), ms: 250 };
}

async function main() {
  console.log("site scan browser read:");
  const db = await setupToolsDatabase();
  for (const f of ["bravo__259_site_scans.sql", "bravo__260_site_scan_events.sql", "bravo__261_site_scan_screenshot.sql"]) {
    await applyMigrationFile(db, join(ROOT, "database", "turso", f));
  }
  const br = await import("../lib/site-scan/browser-read");
  const run = await import("../lib/site-scan/run");
  const h = await import("../lib/tools/runner-handlers");
  const { insertScan, getScan } = await import("../lib/site-scan/store");
  const { listEvents } = await import("../lib/site-scan/events");

  const t0 = new Date("2026-11-14T03:00:00.000Z");
  const tier0 = (fetch: (url: string) => Promise<Response>) => ({ site: { fetch, clock: () => t0.getTime() }, pagespeed: null, now: () => t0 });

  await check("the runner's answers are checked field by field", async () => {
    assert.deepEqual(br.parseBrowserPages("x"), { ok: false, field: "pages" });
    assert.deepEqual(br.parseBrowserPages([{ url: "ftp://x.ca/", status: 200 }]), { ok: false, field: "pages.url" });
    assert.deepEqual(br.parseBrowserPages([{ url: `${SITE}/`, status: 99 }]), { ok: false, field: "pages.status" });
    assert.deepEqual(br.parseBrowserPages([{ url: `${SITE}/`, status: 200, body: 5 }]), { ok: false, field: "pages.body" });
    assert.deepEqual(br.parseBrowserPages(Array.from({ length: br.MAX_BROWSER_PAGES + 1 }, (_, i) => ({ url: `${SITE}/${i}`, status: 200 }))), { ok: false, field: "pages" });
    const p = br.parseBrowserPages([browserPage(`${SITE}/#top`), browserPage(`${SITE}/`)]);
    assert.ok(p.ok && p.pages.length === 1 && p.pages[0].url === `${SITE}/`, "a fragment is dropped and a repeat keeps the first");
    assert.equal(br.wantsBrowserRead("home_page_failed"), true);
    assert.equal(br.wantsBrowserRead("not_allowed"), false, "a robots.txt that closes the site is final");
  });

  await check("the replay answers as the browser saw, moves the clock by its time, and lists what it was not given", async () => {
    const p = br.parseBrowserPages([browserPage(`${SITE}/`), browserPage("http://bayside-plumbing.ca/")]);
    assert.ok(p.ok);
    const { deps, missing } = br.replayRead(p.pages, 1_000);
    const home = await deps.fetch(`${SITE}/`, { method: "GET", redirect: "manual", signal: new AbortController().signal, headers: {} });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Bayside Plumbing/);
    assert.equal(deps.clock(), 1_420);
    const hop = await deps.fetch("http://bayside-plumbing.ca/", { method: "GET", redirect: "manual", signal: new AbortController().signal, headers: {} });
    assert.equal(hop.status, 301);
    assert.equal(hop.headers.get("location"), `${SITE}/`);
    await assert.rejects(deps.fetch(`${SITE}/contact`, { method: "GET", redirect: "manual", signal: new AbortController().signal, headers: {} }));
    assert.deepEqual([...missing], [`${SITE}/contact`]);
  });

  await seedRunner(db, t0, ["site_scan_enrich"], "bea:oasis-vps-audit");
  const { row } = await insertScan(db, { tenantId: OASIS, domain: "bayside-plumbing.ca", url: `${SITE}/`, ipHash: null, now: t0 });

  await check("a site that refuses the Worker is handed to the runner's browser, not closed empty", async () => {
    const out = await run.runTier0(db, { tenantId: OASIS, scanId: row.id }, tier0(refusingSite()));
    assert.deepEqual(out, { ok: true, code: "browser_read" });
    const scan = (await getScan(db, OASIS, row.id))!;
    assert.equal(scan.status, "enriching");
    assert.equal(scan.facts?.site.unread, "home_page_failed");
    const jobs = await db.execute({ sql: "SELECT id FROM tool_jobs WHERE tool_key = 'site_scan_enrich' AND json_extract(input_json, '$.scan_id') = ?", args: [row.id] });
    assert.equal(jobs.rows.length, 1, "the runner's job is queued");
  });

  const jobId = String((await db.execute({ sql: "SELECT id FROM tool_jobs WHERE json_extract(input_json, '$.scan_id') = ?", args: [row.id] })).rows[0].id);
  await db.execute({ sql: "UPDATE tool_jobs SET status = 'running', claimed_by = 'bea:oasis-vps-audit', lease_id = ? WHERE id = ?", args: [LEASE, jobId] });
  const base = { runner_id: "oasis-vps-audit", job_id: jobId, lease_id: LEASE };
  const post = (body: Record<string, unknown>) => h.handleToolsScanPages(signedRequest("scan-pages", body, t0), { db, env: ENV, now: t0, storage: null }).then(answerOf);

  await check("the browser's read goes in rounds: what the reader still wants comes back, nothing is written meanwhile", async () => {
    const first = [`${SITE}/robots.txt`, `${SITE}/`, "http://bayside-plumbing.ca/", "http://bayside-plumbing.ca/robots.txt", `${SITE}/sitemap.xml`].map(browserPage);
    const a = await post({ ...base, round: 1, pages: first });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const need = a.body.need as string[];
    assert.ok(Array.isArray(need) && need.length >= 2, JSON.stringify(a.body));
    assert.ok(need.every((u) => u.startsWith(`${SITE}/`)), "only the site's own pages are asked for");
    assert.ok(need.includes(`${SITE}/contact`), "the planner's pages, chosen by readSite itself");
    assert.equal((await getScan(db, OASIS, row.id))!.facts?.site.unread, "home_page_failed", "nothing written in a round that needs more");

    const b = await post({ ...base, round: 2, pages: [...first, ...need.map(browserPage)] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.done, true);
    assert.equal(b.body.unread, null);
    const input = b.body.input as { facts: { site: { unread: unknown; pages_read: number } }; text_excerpt: string };
    assert.equal(input.facts.site.unread, null, "the runner matches on the browser's read");
    assert.ok(input.facts.site.pages_read >= 2);
    assert.match(input.text_excerpt, /water heaters/);

    const scan = (await getScan(db, OASIS, row.id))!;
    assert.equal(scan.status, "enriching", "the runner still has the matching to do");
    assert.equal(scan.facts?.signals?.business_name, "Bayside Plumbing");
    assert.ok(scan.score && typeof scan.score.total === "number", "scored from the browser's read");
    assert.equal(scan.facts?.site.response_ms, 420, "the browser's own time for the home page");
    const feed = await listEvents(db, { tenantId: OASIS, scanId: row.id, afterId: 0 });
    assert.ok(feed.some((e) => e.source === "runner" && e.kind === "page"), "the pages it read are told to the feed");
    assert.ok(feed.some((e) => e.source === "runner" && e.kind === "score"));
  });

  await check("a read already done is never overwritten, and only the scan's own tool may post", async () => {
    const again = await post({ ...base, round: 1, pages: [browserPage(`${SITE}/robots.txt`)] });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "not_wanted");
    const r = await post({ ...base, round: 9, pages: [] });
    assert.equal(r.status, 422);
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'ai_audit_pdf' WHERE id = ?", args: [jobId] });
    const wrongTool = await post({ ...base, round: 1, pages: [] });
    assert.equal(wrongTool.status, 422);
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'site_scan_enrich' WHERE id = ?", args: [jobId] });
  });

  await check("a robots.txt that closes the site stays final: no browser, the report closes", async () => {
    const { row: closed } = await insertScan(db, { tenantId: OASIS, domain: "closed-site.ca", url: "https://closed-site.ca/", ipHash: null, now: t0 });
    const out = await run.runTier0(db, { tenantId: OASIS, scanId: closed.id }, tier0(refusingSite("User-agent: *\nDisallow: /\n")));
    assert.deepEqual(out, { ok: true, code: "unread" });
    assert.equal((await getScan(db, OASIS, closed.id))!.status, "done");
  });

  await check("with no runner listening, a refused site closes at once as before", async () => {
    await db.execute("UPDATE tool_runners SET last_seen_at = '2020-01-01T00:00:00.000Z'");
    const { row: lone } = await insertScan(db, { tenantId: OASIS, domain: "lone-site.ca", url: "https://lone-site.ca/", ipHash: null, now: t0 });
    const out = await run.runTier0(db, { tenantId: OASIS, scanId: lone.id }, tier0(refusingSite()));
    assert.deepEqual(out, { ok: true, code: "unread" });
    assert.equal((await getScan(db, OASIS, lone.id))!.status, "done");
  });

  finish("site-scan-browser-read");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
