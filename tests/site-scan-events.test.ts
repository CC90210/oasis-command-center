/**
 * tests/site-scan-events.test.ts — the free scan's live feed, end to end on a throwaway local libSQL
 * file with a fake site (no network): bravo__260 on top of bravo__259; events cleaned, capped and
 * read back by cursor; the buffered sink; one Tier 0 claim per read (stream vs POST fallback, and
 * again after a retry); Tier 0 writing a real feed from a real read; the stream's frames (replay,
 * resume, the final report, the window); and the feed's words for each kind of result.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-events.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { appendEvents, cleanEvent, EventSink, listEvents, MAX_EVENTS_PER_SCAN, MAX_EVENT_TEXT } from "../lib/site-scan/events";
import { checkLines, pageLine, planLine, scoreLines, shortTitle, signalLines, speedLine } from "../lib/site-scan/live";
import { runTier0Live } from "../lib/site-scan/run";
import { claimTier0, getScan, insertScan, purgeExpiredScans, setStatus } from "../lib/site-scan/store";
import { encodeScanFrame, followScan, resumeAfter, WINDOW_MS, type ScanFrame } from "../lib/site-scan/stream";
import type { FetchLike } from "../lib/ai-audit/site-fetch";
import type { SiteSignals } from "../lib/site-scan/types";

const ROOT = join(__dirname, "..");
const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

async function migrate(db: Client) {
  for (const f of ["bravo__206_tool_jobs.sql", "bravo__259_site_scans.sql", "bravo__260_site_scan_events.sql"]) {
    await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", f), "utf8"));
  }
}

const HOME = `<!doctype html><html lang="en-CA"><head><title>Acme Plumbing | Hamilton</title>
<meta name="viewport" content="width=device-width"><meta name="description" content="Plumbers in Hamilton since 1990."></head>
<body><nav><a href="/contact">Contact</a><a href="/services">Services</a></nav><h1>Fast plumbers, 24/7</h1>
<p>Call <a href="tel:+19055550100">905 555 0100</a>. Serving Hamilton, Ontario.</p><footer>&copy; 2026 Acme</footer></body></html>`;
const CONTACT = `<html><head><title>Contact | Acme</title></head><body><form action="/x"><input name="email"></form></body></html>`;
const SERVICES = `<html><head><title>Services | Acme</title></head><body><h1>Drain cleaning</h1></body></html>`;

/** A small site that answers like a real one: robots, a home page, two linked pages, no sitemap, http to https. */
const fakeSite: FetchLike = async (url) => {
  const u = new URL(url);
  const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  if (u.protocol === "http:") return new Response("", { status: 301, headers: { location: `https://${u.host}${u.pathname}` } });
  if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
  if (u.pathname === "/") return html(HOME);
  if (u.pathname === "/contact") return html(CONTACT);
  if (u.pathname === "/services") return html(SERVICES);
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
};

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "site-scan-events-"));
  const db = createClient({ url: `file:${join(dir, "t.db")}` });
  try {
    await migrate(db);
    const t0 = new Date("2026-11-12T10:00:00.000Z");

    // ── Cleaning: a known kind, one line, capped text; oversized data is dropped, never cut. ──
    assert.equal(cleanEvent({ kind: "bogus", text: "x", at: t0.toISOString() }), null);
    assert.equal(cleanEvent({ kind: "note", text: "   ", at: t0.toISOString() }), null);
    const long = cleanEvent({ kind: "note", text: `a\n\n${"b".repeat(400)}`, data: { big: "z".repeat(2_000) }, at: t0.toISOString() });
    assert.ok(long && long.text.startsWith("a b") && long.text.length === MAX_EVENT_TEXT && long.dataJson === null);
    assert.equal(cleanEvent({ kind: "page", text: "ok", data: { path: "/" }, at: t0.toISOString() })?.dataJson, '{"path":"/"}');

    // ── Append, cap, cursor, tenant scope. ──
    const { row } = await insertScan(db, { tenantId: TENANT, domain: "acme-plumbing.ca", url: "https://acme-plumbing.ca/", ipHash: null, now: t0 });
    const many = Array.from({ length: MAX_EVENTS_PER_SCAN + 5 }, (_, i) => cleanEvent({ kind: "note", text: `line ${i}`, at: t0.toISOString() })!);
    assert.equal(await appendEvents(db, { tenantId: TENANT, scanId: "other-scan", source: "worker", events: many }), MAX_EVENTS_PER_SCAN, "one scan's feed stops at the cap");
    const firstTen = await listEvents(db, { tenantId: TENANT, scanId: "other-scan", afterId: 0, limit: 10 });
    assert.deepEqual(firstTen.map((e) => e.text), Array.from({ length: 10 }, (_, i) => `line ${i}`));
    const next = await listEvents(db, { tenantId: TENANT, scanId: "other-scan", afterId: firstTen[9].id, limit: 2 });
    assert.deepEqual(next.map((e) => e.text), ["line 10", "line 11"], "a cursor resumes after the last id seen");
    assert.equal((await listEvents(db, { tenantId: "someone-else", scanId: "other-scan", afterId: 0 })).length, 0);

    // ── The sink writes in order and survives a database without the table. ──
    const sink = new EventSink(db, { tenantId: TENANT, scanId: "sink-scan", source: "runner", now: () => t0 });
    for (let i = 0; i < 25; i++) sink.emit("check", `c${i}`, { i });
    await sink.close();
    const sunk = await listEvents(db, { tenantId: TENANT, scanId: "sink-scan", afterId: 0 });
    assert.deepEqual(sunk.map((e) => e.text), Array.from({ length: 25 }, (_, i) => `c${i}`));
    assert.ok(sunk.every((e) => e.source === "runner" && e.data && typeof e.data.i === "number"));
    const bare = createClient({ url: `file:${join(dir, "bare.db")}` });
    const offSink = new EventSink(bare, { tenantId: TENANT, scanId: "x", source: "worker", now: () => t0 });
    offSink.emit("note", "nowhere to go");
    await offSink.close();
    assert.deepEqual(await listEvents(bare, { tenantId: TENANT, scanId: "x", afterId: 0 }), [], "no table reads as an empty feed");
    bare.close();

    // ── One Tier 0 per read: the first claim wins, a retry of a failed scan is claimable again. ──
    assert.equal(await claimTier0(db, { tenantId: TENANT, id: row.id, now: t0 }), "claimed");
    assert.equal(await claimTier0(db, { tenantId: TENANT, id: row.id, now: t0 }), "taken", "the stream and POST's fallback never both run it");
    await setStatus(db, { tenantId: TENANT, id: row.id, status: "failed", stage: "read", errorCode: "read_failed", now: t0 });
    assert.equal(await claimTier0(db, { tenantId: TENANT, id: row.id, now: t0 }), "taken", "only a reading scan is claimable");
    const retry = await insertScan(db, { tenantId: TENANT, domain: "acme-plumbing.ca", url: "https://acme-plumbing.ca/", ipHash: null, now: new Date(t0.getTime() + 60_000) });
    assert.ok(retry.started && retry.row.id === row.id);
    assert.equal(await claimTier0(db, { tenantId: TENANT, id: row.id, now: t0 }), "claimed", "a retried scan is read again");
    const old = createClient({ url: `file:${join(dir, "old.db")}` });
    await old.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__259_site_scans.sql"), "utf8"));
    assert.equal(await claimTier0(old, { tenantId: TENANT, id: row.id, now: t0 }), "unsupported", "a database before bravo__260 falls back to the old path");
    const oldRow = await insertScan(old, { tenantId: TENANT, domain: "old.ca", url: "https://old.ca/", ipHash: null, now: t0 });
    await setStatus(old, { tenantId: TENANT, id: oldRow.row.id, status: "failed", stage: "read", errorCode: "read_failed", now: t0 });
    const oldRetry = await insertScan(old, { tenantId: TENANT, domain: "old.ca", url: "https://old.ca/", ipHash: null, now: new Date(t0.getTime() + 60_000) });
    assert.ok(oldRetry.started && oldRetry.row.status === "reading", "a retry still resets on a database before bravo__260");
    old.close();

    // ── Tier 0 writes a real feed from a real read (no runner: it finishes with the Worker's report). ──
    const clock = { ms: Date.parse("2026-11-12T10:01:00.000Z") };
    await runTier0Live(db, { tenantId: TENANT, scanId: row.id }, { site: { fetch: fakeSite, clock: () => clock.ms }, pagespeed: null, now: () => new Date(clock.ms) });
    const done = await getScan(db, TENANT, row.id);
    assert.equal(done?.status, "done");
    const feed = await listEvents(db, { tenantId: TENANT, scanId: row.id, afterId: 0 });
    const texts = feed.map((e) => e.text);
    assert.ok(texts[0].startsWith("Opening https://acme-plumbing.ca/ "), texts[0]);
    assert.equal(texts.filter((t) => t === "Read robots.txt to see what the site allows a reader to open").length, 1, "robots.txt is said once, however many addresses ask for it");
    assert.ok(feed.some((e) => e.kind === "page" && /^Read \/ "Acme Plumbing \| Hamilton"/.test(e.text)), texts.join("\n"));
    assert.ok(feed.some((e) => e.kind === "note" && /^Opening 2 pages a buyer would look at next: contact, services/.test(e.text)), texts.join("\n"));
    assert.ok(texts.includes("Plain http:// sends visitors on to the secure address"));
    assert.ok(feed.some((e) => e.kind === "check" && e.text === "Tap-to-call phone link: found"), texts.join("\n"));
    assert.ok(feed.some((e) => e.kind === "check" && e.text === "Secure address (HTTPS): good"), "a quality check says good, not yes");
    assert.ok(feed.some((e) => e.kind === "signal" && e.text === 'The business calls itself "Acme Plumbing"'));
    assert.ok(feed.some((e) => e.kind === "score" && /^OASIS score: \d+ out of 100/.test(e.text)));
    assert.equal(feed[feed.length - 1].kind, "done", "the feed ends with its own last step");
    assert.ok(feed.every((e) => e.source === "worker"));

    // ── The stream: replay in order, the scan first, the final report once it is over; resume by id. ──
    const frames: ScanFrame[] = [];
    let nowMs = Date.parse("2026-11-12T10:02:00.000Z");
    for await (const f of followScan({ db, tenantId: TENANT, scanId: row.id, afterId: 0, now: () => new Date(nowMs), sleep: async (ms) => void (nowMs += ms), gone: () => false, driving: () => false })) {
      frames.push(f);
    }
    const evFrames = frames.filter((f): f is Extract<ScanFrame, { type: "event" }> => f.type === "event");
    assert.deepEqual(evFrames.map((f) => f.event.id), feed.map((e) => e.id), "every line, once, in order");
    assert.ok(frames.some((f) => f.type === "scan"), "the scan itself is sent");
    assert.equal(frames[frames.length - 1].type, "end", "a finished scan ends the stream with its report");
    const resumed: ScanFrame[] = [];
    for await (const f of followScan({ db, tenantId: TENANT, scanId: row.id, afterId: feed[feed.length - 3].id, now: () => new Date(nowMs), sleep: async (ms) => void (nowMs += ms), gone: () => false, driving: () => false })) resumed.push(f);
    assert.equal(resumed.filter((f) => f.type === "event").length, 2, "a reconnect gets only what it has not seen");

    // A scan still being enriched ends its window and asks the browser to come back, unless this
    // connection is the one running Tier 0.
    await setStatus(db, { tenantId: TENANT, id: row.id, status: "enriching", stage: "profile", now: new Date(nowMs) });
    const waiting: ScanFrame[] = [];
    for await (const f of followScan({ db, tenantId: TENANT, scanId: row.id, afterId: feed[feed.length - 1].id, now: () => new Date(nowMs), sleep: async (ms) => void (nowMs += ms), gone: () => false, driving: () => false })) waiting.push(f);
    assert.equal(waiting[waiting.length - 1].type, "window");
    const started = nowMs;
    let driving = true;
    const driven: ScanFrame[] = [];
    for await (const f of followScan({ db, tenantId: TENANT, scanId: row.id, afterId: feed[feed.length - 1].id, now: () => new Date(nowMs), sleep: async (ms) => {
      nowMs += ms;
      if (nowMs - started > WINDOW_MS * 2) driving = false;
    }, gone: () => false, driving: () => driving })) driven.push(f);
    assert.ok(nowMs - started > WINDOW_MS * 2, "a driving connection outlasts the window");

    // Wire format, and where a reconnect resumes.
    assert.equal(encodeScanFrame({ type: "event", event: feed[0] }).split("\n")[0], `id: ${feed[0].id}`);
    assert.equal(encodeScanFrame({ type: "ping" }), ": ping\n\n");
    assert.equal(resumeAfter("0", "41"), 41);
    assert.equal(resumeAfter("7", null), 7);
    assert.equal(resumeAfter("-3", "x"), 0);

    // ── A purged scan takes its feed with it. ──
    await db.execute({ sql: "UPDATE site_scans SET expires_at = ? WHERE id = ?", args: ["2000-01-01T00:00:00.000Z", row.id] });
    await purgeExpiredScans(db, TENANT, new Date("2026-12-31T00:00:00.000Z"));
    assert.equal((await listEvents(db, { tenantId: TENANT, scanId: row.id, afterId: 0 })).length, 0);

    // ── The feed's words. ──
    assert.equal(pageLine({ kind: "robots_txt", url: "https://a.example/robots.txt", finalUrl: null, status: 404, bytes: 0, ms: 5, title: null, error: null, html: null }).text, "No robots.txt (HTTP 404), so the site's public pages are open to read");
    assert.equal(pageLine({ kind: "site_page", url: "https://a.example/x", finalUrl: null, status: null, bytes: 0, ms: 0, title: null, error: "timed_out", html: null }).text, "Could not open /x: it did not answer in time");
    assert.equal(planLine([]).text, "The home page links to no contact, booking, services or pricing page to open next");
    assert.deepEqual(checkLines([{ key: "online_booking", status: "no", detail: "", found: [], evidence: null }]).map((l) => l.text), ["Online booking: missing"]);
    assert.deepEqual(checkLines([{ key: "response_time", status: "no", detail: "", found: [], evidence: null }, { key: "analytics", status: "yes", detail: "", found: ["Google Analytics"], evidence: null }]).map((l) => l.text), ["Home page response time: slow", "Visitor analytics: found (Google Analytics)"]);
    assert.equal(shortTitle("Paint Store in Hamilton | Bay City Paint | Bay City Paint &amp; Wallpaper Inc"), "Paint Store in Hamilton | Bay City Paint | Bay City Paint & Wallpaper...");
    assert.equal(shortTitle("Contact &#124; Acme"), "Contact | Acme");
    assert.match(speedLine(null).text, /^Google's phone test was not run/);
    const sig = { business_name: "Acme", tagline: null, localities: [], services: [], phones: [], emails: [], booking_tools: [], chat_tools: [], analytics: [], socials: {}, pricing_mentioned: false, keywords: [], language: null } as unknown as SiteSignals;
    assert.ok(signalLines(sig).some((l) => l.text === "No phone number found on the pages read"), "a missing finding is said plainly");
    assert.equal(scoreLines({ schema: "site_scan/score/v1", total: null, pillars: [], fixes: [] }).at(0)?.text, "Too little of the site could be read from outside to give a score");

    console.log("site-scan-events: ok");
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a just-closed libSQL file a moment longer; the OS clears tmp.
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
