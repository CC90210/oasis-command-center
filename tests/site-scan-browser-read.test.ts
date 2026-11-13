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

    // Requests made at once (the reader's batches of four) spend the budget as the latest of their ends, not their sum.
    const four = br.parseBrowserPages(["a", "b", "c", "d"].map((p) => ({ url: `${SITE}/${p}`, status: 200, content_type: "text/html", body: "<p>x</p>", ms: 1_000 })));
    assert.ok(four.ok);
    const batch = br.replayRead(four.pages, 0);
    const req = () => ({ method: "GET" as const, redirect: "manual" as const, signal: new AbortController().signal, headers: {} });
    await Promise.all(four.pages.map((p) => batch.deps.fetch(p.url, req())));
    assert.equal(batch.deps.clock(), 1_000, "four pages at once took one second, not four");
    await batch.deps.fetch(four.pages[0].url, req());
    assert.equal(batch.deps.clock(), 2_000, "one alone adds its own time");
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

  await check("a retry gets the finished read back, nothing overwritten; a lease that no longer holds writes nothing; only the scan's own tool may post", async () => {
    const before = (await getScan(db, OASIS, row.id))!;
    const again = await post({ ...base, round: 1, pages: [browserPage(`${SITE}/robots.txt`)] });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.done, again.body.repeated], [true, true], "a lost answer or a retry: the result again");
    assert.ok((again.body.input as { facts?: unknown })?.facts, "with the job's input rebuilt from the saved read");
    assert.deepEqual((await getScan(db, OASIS, row.id))!.facts, before.facts, "the saved read is untouched");
    const { saveBrowserRead } = await import("../lib/site-scan/store");
    await db.execute({ sql: "UPDATE site_scans SET facts_json = json_set(facts_json, '$.site.unread', 'home_page_failed') WHERE id = ?", args: [row.id] });
    const stale = await saveBrowserRead(db, { tenantId: OASIS, id: row.id, facts: before.facts!, score: before.score!, narrative: before.narrative!, now: t0, lease: { jobId, runnerKey: "bea:oasis-vps-audit", leaseId: "f".repeat(32) } });
    assert.equal(stale, false, "a runner whose lease moved on writes nothing");
    assert.equal((await getScan(db, OASIS, row.id))!.facts?.site.unread, "home_page_failed");
    await db.execute({ sql: "UPDATE site_scans SET facts_json = ? WHERE id = ?", args: [JSON.stringify(before.facts), row.id] });
    const r = await post({ ...base, round: 9, pages: [] });
    assert.equal(r.status, 422);
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'ai_audit_pdf' WHERE id = ?", args: [jobId] });
    const wrongTool = await post({ ...base, round: 1, pages: [] });
    assert.equal(wrongTool.status, 422);
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'site_scan_enrich' WHERE id = ?", args: [jobId] });
  });

  await check("a page drawn by JavaScript (almost no text for the Worker) is flagged thin and read by the browser", async () => {
    const shell = `<!doctype html><html><head><title>Loading</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    const jsSite = async (url: string) =>
      url.endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } })
        : new Response(shell, { status: 200, headers: { "content-type": "text/html" } });
    const { row: js } = await insertScan(db, { tenantId: OASIS, domain: "bayside-plumbing.ca", url: `${SITE}/`, ipHash: null, now: new Date(t0.getTime() + 86_400_000) });
    const out = await run.runTier0(db, { tenantId: OASIS, scanId: js.id }, tier0(jsSite));
    assert.equal(out.ok, true);
    const before = (await getScan(db, OASIS, js.id))!;
    assert.equal(before.facts?.site.unread, null);
    assert.equal(before.facts?.site.thin, true, "too little text to be the site a visitor sees");
    assert.equal(br.needsBrowserRead(before.facts?.site), true);
    const job = String((await db.execute({ sql: "SELECT id FROM tool_jobs WHERE json_extract(input_json, '$.scan_id') = ?", args: [js.id] })).rows[0].id);
    await db.execute({ sql: "UPDATE tool_jobs SET status = 'running', claimed_by = 'bea:oasis-vps-audit', lease_id = ? WHERE id = ?", args: [LEASE, job] });
    const pages = [`${SITE}/robots.txt`, `${SITE}/`, "http://bayside-plumbing.ca/", "http://bayside-plumbing.ca/robots.txt", `${SITE}/sitemap.xml`, `${SITE}/services`, `${SITE}/contact`, `${SITE}/about`].map(browserPage);
    const done = await h
      .handleToolsScanPages(signedRequest("scan-pages", { runner_id: "oasis-vps-audit", job_id: job, lease_id: LEASE, round: br.MAX_BROWSER_ROUNDS, pages }, t0), { db, env: ENV, now: t0, storage: null })
      .then(answerOf);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.done, true);
    const after = (await getScan(db, OASIS, js.id))!;
    assert.equal(after.facts?.signals?.business_name, "Bayside Plumbing", "the browser's read replaced the shell");
    assert.equal(after.facts?.site.thin, undefined, "the browser's read is not flagged again");
    assert.ok((after.facts?.signals?.word_count ?? 0) >= br.THIN_WORDS);

    // A browser read that is thin too: kept, and flagged (the report's own word on how much was read).
    const day2 = new Date(t0.getTime() + 2 * 86_400_000);
    const { row: still } = await insertScan(db, { tenantId: OASIS, domain: "shell-site.ca", url: "https://shell-site.ca/", ipHash: null, now: day2 });
    await seedRunner(db, day2, ["site_scan_enrich"], "bea:oasis-vps-audit");
    assert.equal((await run.runTier0(db, { tenantId: OASIS, scanId: still.id }, { ...tier0(jsSite), now: () => day2 })).ok, true);
    const job2 = String((await db.execute({ sql: "SELECT id FROM tool_jobs WHERE json_extract(input_json, '$.scan_id') = ?", args: [still.id] })).rows[0].id);
    await db.execute({ sql: "UPDATE tool_jobs SET status = 'running', claimed_by = 'bea:oasis-vps-audit', lease_id = ? WHERE id = ?", args: [LEASE, job2] });
    const shellPage = (url: string) => ({ ...browserPage(url), ...(new URL(url).pathname === "/" && url.startsWith("https://") ? { body: shell } : {}) });
    const shellPages = [`https://shell-site.ca/robots.txt`, `https://shell-site.ca/`, "http://shell-site.ca/", "http://shell-site.ca/robots.txt", `https://shell-site.ca/sitemap.xml`].map(shellPage);
    const thinAgain = await h
      .handleToolsScanPages(signedRequest("scan-pages", { runner_id: "oasis-vps-audit", job_id: job2, lease_id: LEASE, round: br.MAX_BROWSER_ROUNDS, pages: shellPages }, day2), { db, env: ENV, now: day2, storage: null })
      .then(answerOf);
    assert.equal(thinAgain.status, 200, JSON.stringify(thinAgain.body));
    assert.equal(thinAgain.body.done, true);
    const kept = (await getScan(db, OASIS, still.id))!;
    assert.equal(kept.facts?.site.thin, true, "the browser's thin read is flagged");
    await db.execute({ sql: "UPDATE site_scans SET status = 'done', stage = 'done' WHERE id = ?", args: [still.id] });
    const day2later = new Date(day2.getTime() + 3_600_000);
    assert.equal((await insertScan(db, { tenantId: OASIS, domain: "shell-site.ca", url: "https://shell-site.ca/", ipHash: null, now: day2later })).started, true, "today's is read again");
  });

  await check("a robots.txt that closes the site stays final: no browser, the report closes", async () => {
    const { row: closed } = await insertScan(db, { tenantId: OASIS, domain: "closed-site.ca", url: "https://closed-site.ca/", ipHash: null, now: t0 });
    const out = await run.runTier0(db, { tenantId: OASIS, scanId: closed.id }, tier0(refusingSite("User-agent: *\nDisallow: /\n")));
    assert.deepEqual(out, { ok: true, code: "unread" });
    assert.equal((await getScan(db, OASIS, closed.id))!.status, "done");
  });

  await check("a finished report, empty or good, is read again in place for the next visitor today", async () => {
    const { row: empty } = await insertScan(db, { tenantId: OASIS, domain: "empty-site.ca", url: "https://empty-site.ca/", ipHash: null, now: t0 });
    await db.execute({ sql: "UPDATE site_scans SET status = 'done', facts_json = ? WHERE id = ?", args: [JSON.stringify({ site: { unread: "home_page_failed" } }), empty.id] });
    const later = new Date(t0.getTime() + 3_600_000);
    const again = await insertScan(db, { tenantId: OASIS, domain: "empty-site.ca", url: "https://empty-site.ca/", ipHash: null, now: later });
    assert.equal(again.row.id, empty.id);
    assert.equal(again.started, true, "today's empty report is read again in place");

    // A good report too: every scan a visitor starts is a real run they watch (CC, 2026-11-13).
    const { row: good } = await insertScan(db, { tenantId: OASIS, domain: "good-site.ca", url: "https://good-site.ca/", ipHash: null, now: t0 });
    await db.execute({ sql: "UPDATE site_scans SET status = 'done', facts_json = ? WHERE id = ?", args: [JSON.stringify({ site: { unread: null } }), good.id] });
    const goodAgain = await insertScan(db, { tenantId: OASIS, domain: "good-site.ca", url: "https://good-site.ca/", ipHash: null, now: later });
    assert.equal(goodAgain.row.id, good.id);
    assert.equal(goodAgain.started, true, "a good report is read again too");
    assert.equal(goodAgain.row.facts, null, "the earlier read is not shown as the new one's");
  });

  await check("a site read again in place gets a runner job of its own, a finished one from before never in its way", async () => {
    const { row: retry } = await insertScan(db, { tenantId: OASIS, domain: "retry-site.ca", url: "https://retry-site.ca/", ipHash: null, now: t0 });
    assert.deepEqual(await run.runTier0(db, { tenantId: OASIS, scanId: retry.id }, tier0(refusingSite())), { ok: true, code: "browser_read" });
    const jobsOf = async () => (await db.execute({ sql: "SELECT id, status FROM tool_jobs WHERE json_extract(input_json, '$.scan_id') = ? ORDER BY created_at", args: [retry.id] })).rows;
    assert.equal((await jobsOf()).length, 1);
    // That job finishes on the empty read (a runner before this change); the report closes empty.
    await db.execute({ sql: "UPDATE tool_jobs SET status = 'done' WHERE json_extract(input_json, '$.scan_id') = ?", args: [retry.id] });
    await db.execute({ sql: "UPDATE site_scans SET status = 'done', stage = 'done' WHERE id = ?", args: [retry.id] });
    // The next visitor today: the empty report is read again in place, and the new read needs a runner.
    const later = new Date(t0.getTime() + 3_600_000);
    const again = await insertScan(db, { tenantId: OASIS, domain: "retry-site.ca", url: "https://retry-site.ca/", ipHash: null, now: later });
    assert.equal(again.row.id, retry.id);
    assert.equal(again.started, true);
    await seedRunner(db, later, ["site_scan_enrich"], "bea:oasis-vps-audit"); // still listening an hour on
    assert.deepEqual(await run.runTier0(db, { tenantId: OASIS, scanId: retry.id }, { ...tier0(refusingSite()), now: () => later }), { ok: true, code: "browser_read" });
    const jobs = await jobsOf();
    assert.equal(jobs.length, 2, "a second job, queued: the finished one's key is not the new attempt's");
    assert.equal(jobs[1].status, "queued");
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
