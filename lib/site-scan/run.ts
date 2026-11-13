/**
 * lib/site-scan/run.ts — Tier 0 of the free scan, run inside the visitor's live stream
 * (app/api/scan/[id]/stream), or by POST /api/scan's fallback when no stream claimed it.
 *
 * Reads the site (the audit's robots-respecting reader), runs the checks, extracts the signals,
 * asks PageSpeed (tolerant: a refusal or a timeout is a gap, never a failure), scores it, writes
 * the base narrative, and queues the runner's enrichment job. Keyless end to end.
 *
 * Fetches are passed in so tests run on fixtures without a network.
 */
import type { Client } from "@libsql/client";
import { defaultSiteDeps } from "@/lib/ai-audit/briefs";
import { defaultPageSpeedDeps } from "@/lib/ai-audit/research";
import { runPageSpeed, type PageSpeedFetch, type PageSpeedResult } from "@/lib/ai-audit/pagespeed";
import type { PageSnapshot } from "@/lib/ai-audit/site-checks";
import { readSite, type PageRecord, type SiteReadDeps, type SiteReport } from "@/lib/ai-audit/site-fetch";
import { siteTarget } from "@/lib/ai-audit/site-url";
import { inputHashOf, insertJob, isMissingToolTables, liveRunnerForTool, newJobId } from "@/lib/tools/store";
import { baseNarrative } from "@/lib/site-scan/narrative";
import { scoreFacts } from "@/lib/site-scan/score";
import { extractSignals } from "@/lib/site-scan/signals";
import { getScan, saveBrowserRead, saveTier0, setStatus, type ScanLease } from "@/lib/site-scan/store";
import { appendEvents, cleanEvent, eventsTableMissing, EventSink, NO_EVENTS, type CleanEvent, type ScanEvents } from "@/lib/site-scan/events";
import { checkLines, pageLine, planLine, scoreLines, signalLines, speedLine, type Line } from "@/lib/site-scan/live";
import { isThinRead, needsBrowserRead, replayRead, wantsBrowserRead, type BrowserPage } from "@/lib/site-scan/browser-read";
import { FACTS_SCHEMA, type ScanFacts, type ScanNarrative, type ScanScore } from "@/lib/site-scan/types";

export const ENRICH_TOOL_KEY = "site_scan_enrich" as const;
export const PAGESPEED_SCAN_TIMEOUT_MS = 20_000;

export type Tier0Deps = {
  site: SiteReadDeps;
  pagespeed: { fetch: PageSpeedFetch; key: string | null } | null;
  now: () => Date;
};

export function defaultTier0Deps(): Tier0Deps {
  return { site: defaultSiteDeps(), pagespeed: defaultPageSpeedDeps(), now: () => new Date() };
}

/**
 * The pages the checks measured. The reader's own list when it has one: a page it turned away (a
 * bot check, a placeholder, a non-2xx) must not lend the scan its name, phone or services. The
 * rebuild from request records is only for a report without that list.
 */
export function snapshotsOf(report: SiteReport): PageSnapshot[] {
  if (report.checked) return report.checked;
  const out: PageSnapshot[] = [];
  for (const p of report.pages) {
    if (p.kind !== "site_page" || p.status === null || p.html === null) continue;
    out.push({ url: p.url, finalUrl: p.finalUrl ?? p.url, status: p.status, contentType: "text/html", html: p.html, bytes: p.bytes, ms: p.ms, truncated: false });
  }
  return out;
}

export function factsFrom(input: { domain: string; report: SiteReport; pagespeed: PageSpeedResult | null; readAt: string }): ScanFacts {
  const pages = snapshotsOf(input.report);
  const home = pages[0] ?? null;
  const httpsServed = input.report.start.startsWith("https://") && !input.report.checks.some((c) => c.key === "https" && c.status === "no");
  return {
    schema: FACTS_SCHEMA,
    domain: input.domain,
    start_url: input.report.start,
    final_url: home?.finalUrl ?? null,
    read_at: input.readAt,
    site: {
      unread: input.report.unread,
      pages_read: pages.filter((p) => p.status >= 200 && p.status < 300).length,
      notes: input.report.notes.slice(0, 12),
      https_served: httpsServed,
      response_ms: home ? home.ms : null,
      html_kb: home ? Math.round(home.bytes / 1024) : null,
    },
    checks: input.report.checks,
    pagespeed: input.pagespeed,
    signals: input.report.unread ? null : extractSignals({ domain: input.domain, pages }),
  };
}

/**
 * The feed's line for each request the reader records. robots.txt is asked once per address the
 * site answers on (https, www, http); the reader is told about it once.
 */
function pageRecorder(say: (l: Line) => void): (r: PageRecord) => void {
  let robotsSaid = false;
  return (r) => {
    if (r.kind === "robots_txt" && r.error === null) {
      if (robotsSaid) return;
      robotsSaid = true;
    }
    say(pageLine(r));
  };
}

/**
 * What a read becomes: the health lines, the facts, the score and the template narrative, told to
 * the feed as it goes. Shared by the Worker's own read and the browser's (browserRead).
 */
function analyseRead(
  domain: string,
  report: SiteReport,
  pagespeed: PageSpeedResult | null,
  readAt: string,
  say: (l: Line | Line[]) => void,
): { facts: ScanFacts; score: ScanScore; narrative: ScanNarrative } {
  const facts = factsFrom({ domain, report, pagespeed, readAt });
  say(signalLines(facts.signals));
  const score = scoreFacts(facts);
  say(scoreLines(score));
  return { facts, score, narrative: baseNarrative(facts, score) };
}

function healthLines(report: SiteReport, fallback: string): Line[] {
  return report.unread ? [{ kind: "error", text: report.notes[0] ?? fallback }] : checkLines(report.checks);
}

/**
 * Run Tier 0 for one scan row. Idempotent on the row's status: a row no longer `reading` (a second
 * run, a sweep that failed it) is left alone.
 */
export async function runTier0(
  db: Client,
  input: { tenantId: string; scanId: string },
  deps: Tier0Deps = defaultTier0Deps(),
  events: ScanEvents = NO_EVENTS,
): Promise<{ ok: boolean; code?: string }> {
  const say = (lines: Line | Line[]) => {
    for (const l of Array.isArray(lines) ? lines : [lines]) events.emit(l.kind, l.text, l.data);
  };
  const row = await getScan(db, input.tenantId, input.scanId);
  if (!row || row.status !== "reading") return { ok: false, code: row ? `status_${row.status}` : "not_found" };
  const target = siteTarget(row.url);
  if (target.kind !== "site") {
    say({ kind: "error", text: "That address is not a public website" });
    await setStatus(db, { tenantId: input.tenantId, id: row.id, status: "failed", stage: "read", errorCode: "not_a_website", now: deps.now() });
    return { ok: false, code: "not_a_website" };
  }

  say({ kind: "note", text: `Opening ${target.start} the way a first-time buyer would`, data: { url: target.start } });
  const onRecord = pageRecorder(say);
  let report: SiteReport;
  try {
    report = await readSite(target, { ...deps.site, onRecord, onPlan: (p) => say(planLine(p)) });
  } catch (err) {
    console.error("[site-scan.tier0] read failed", { scanId: row.id, error: err instanceof Error ? err.message : String(err) });
    say({ kind: "error", text: "The site could not be read from here" });
    await setStatus(db, { tenantId: input.tenantId, id: row.id, status: "failed", stage: "read", errorCode: "read_failed", now: deps.now() });
    return { ok: false, code: "read_failed" };
  }

  await setStatus(db, { tenantId: input.tenantId, id: row.id, status: "reading", stage: "health", now: deps.now(), onlyFrom: ["reading"] });
  say(healthLines(report, "Nothing on the site could be read"));

  let pagespeed: PageSpeedResult | null = null;
  if (deps.pagespeed && !report.unread) {
    say({ kind: "note", text: "Asking Google to load the home page on a phone (this can take up to 20 seconds)" });
    try {
      pagespeed = await runPageSpeed(report.start, { fetch: deps.pagespeed.fetch, key: deps.pagespeed.key, now: deps.now, timeoutMs: PAGESPEED_SCAN_TIMEOUT_MS });
    } catch (err) {
      console.error("[site-scan.tier0] pagespeed threw", { scanId: row.id, error: err instanceof Error ? err.message : String(err) });
      pagespeed = null;
    }
    say(speedLine(pagespeed));
  }

  const { facts, score, narrative } = analyseRead(row.domain, report, pagespeed, deps.now().toISOString(), say);
  if (isThinRead(facts, score)) {
    // Set either way: a finished thin report is read again by the next visitor (store EMPTY_DONE).
    facts.site.thin = true;
    if (await enrichRunnerLive(db, input.tenantId, deps.now())) {
      say({ kind: "note", text: "Almost nothing on the page could be read without a browser (it is drawn by JavaScript), so a real browser will read it next" });
    }
  }

  if (report.unread) {
    // Refused, not answered, or shown a bot check: hosts that block Cloudflare's network do this to
    // the Worker while answering everyone else. The runner opens the site in a real browser on its
    // own network (browserRead) when one is listening. A robots.txt that closes the site is final.
    if (wantsBrowserRead(report.unread) && (await enrichRunnerLive(db, input.tenantId, deps.now()))) {
      const handed = await saveTier0(db, { tenantId: input.tenantId, id: row.id, facts, score, narrative, status: "enriching", stage: "health", now: deps.now() });
      if (!handed) return { ok: false, code: "status_changed" };
      const queued = await queueEnrichment(db, { tenantId: input.tenantId, scanId: row.id, attempt: row.createdAt, now: deps.now() });
      if (queued.ok) {
        say({ kind: "note", text: "This site turns away our first reader, so a real browser on another network is opening it instead" });
        return { ok: true, code: "browser_read" };
      }
      console.error("[site-scan.tier0] browser read not queued", { scanId: row.id, reason: queued.reason });
      await setStatus(db, { tenantId: input.tenantId, id: row.id, status: "done", stage: "done", errorCode: `enrich_${queued.reason}`, now: deps.now(), onlyFrom: ["enriching"] });
      say({ kind: "done", text: "Report ready" });
      return { ok: true, code: "unread" };
    }
    await saveTier0(db, { tenantId: input.tenantId, id: row.id, facts, score, narrative, status: "done", stage: "done", now: deps.now() });
    say({ kind: "done", text: "Report ready" });
    return { ok: true, code: "unread" };
  }

  const saved = await saveTier0(db, { tenantId: input.tenantId, id: row.id, facts, score, narrative, status: "enriching", stage: "profile", now: deps.now() });
  if (!saved) return { ok: false, code: "status_changed" };

  const queued = await queueEnrichment(db, { tenantId: input.tenantId, scanId: row.id, attempt: row.createdAt, now: deps.now() });
  if (!queued.ok) {
    // No runner tables, or the queue refused: the Worker's own report stands, marked finished.
    console.error("[site-scan.tier0] enrichment not queued", { scanId: row.id, reason: queued.reason });
    await setStatus(db, { tenantId: input.tenantId, id: row.id, status: "done", stage: "done", errorCode: `enrich_${queued.reason}`, now: deps.now(), onlyFrom: ["enriching"] });
    say({ kind: "done", text: "Report ready from the site read; the matching step is not available on this deployment" });
  } else if (!(await enrichRunnerLive(db, input.tenantId, deps.now()))) {
    // Nothing is listening for the job right now. The visitor gets the Worker's report at once; the
    // job stays queued, and a runner that comes back fills the row in for the permalink.
    await setStatus(db, { tenantId: input.tenantId, id: row.id, status: "done", stage: "done", errorCode: "enrich_no_runner", now: deps.now(), onlyFrom: ["enriching"] });
    say({ kind: "done", text: "Report ready from the site read. The matching engine is offline; this link fills in when it is back" });
  } else {
    say({ kind: "note", text: "Handing the profile to the matching engine: what you sell, who buys it, businesses near you" });
  }
  return { ok: true };
}

/**
 * Tier 0 with its feed, for whoever claimed it (the live stream, or POST's fallback). Never
 * throws: a crash closes the scan (closeCrashedTier0) and says so in the feed.
 */
export async function runTier0Live(db: Client, input: { tenantId: string; scanId: string }, deps: Tier0Deps = defaultTier0Deps()): Promise<void> {
  const sink = new EventSink(db, { tenantId: input.tenantId, scanId: input.scanId, source: "worker", now: deps.now });
  try {
    await runTier0(db, input, deps, sink);
  } catch (err) {
    console.error("[site-scan.tier0] crashed", { scanId: input.scanId, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    sink.emit("error", "The scan stopped partway. Scan the site again and it starts fresh");
    await closeCrashedTier0(db, { ...input, now: deps.now() }).catch((closeErr: unknown) => {
      console.error("[site-scan.tier0] crashed scan not closed", { scanId: input.scanId, error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
    });
  } finally {
    await sink.close();
  }
}

/**
 * Close a scan whose Tier 0 threw. A row still reading is failed (a retry resets it, see
 * insertScan); one already saved for enrichment keeps the Worker's report and is marked finished.
 */
export async function closeCrashedTier0(db: Client, input: { tenantId: string; scanId: string; now: Date }): Promise<void> {
  const failed = await setStatus(db, { tenantId: input.tenantId, id: input.scanId, status: "failed", stage: "read", errorCode: "tier0_crashed", now: input.now, onlyFrom: ["queued", "reading"] });
  if (!failed) {
    await setStatus(db, { tenantId: input.tenantId, id: input.scanId, status: "done", stage: "done", errorCode: "enrich_not_queued", now: input.now, onlyFrom: ["enriching"] });
  }
}

/** Has a runner that serves site_scan_enrich claimed within the live window? Read failures count as "no". */
export async function enrichRunnerLive(db: Client, tenantId: string, now: Date): Promise<boolean> {
  try {
    return (await liveRunnerForTool(db, tenantId, ENRICH_TOOL_KEY, now)) !== null;
  } catch (err) {
    console.error("[site-scan.tier0] runner liveness unreadable", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Queue the runner's job for one read attempt. `attempt` is the scan row's created_at: a row read
 * again in place (insertScan's reset) is dated anew, so its job has its own queue identity and a
 * finished job from an earlier read never stands in its way (its idempotency key would, with the
 * scan id alone). Queueing the same attempt twice is still one job.
 */
export async function queueEnrichment(db: Client, input: { tenantId: string; scanId: string; attempt: string; now: Date }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const jobInput = { scan_id: input.scanId };
  try {
    const outcome = await insertJob(
      db,
      {
        id: newJobId(),
        tenantId: input.tenantId,
        toolKey: ENRICH_TOOL_KEY,
        runsOn: "runner",
        input: jobInput,
        inputHash: inputHashOf(ENRICH_TOOL_KEY, jobInput),
        idempotencyKey: `${ENRICH_TOOL_KEY}:${input.scanId}:${input.attempt}`,
        dedupeKey: `${ENRICH_TOOL_KEY}:${input.scanId}`,
        createdBy: null,
        createdByEmail: null,
      },
      input.now,
    );
    return outcome === "inserted" ? { ok: true } : { ok: false, reason: "queue_full" };
  } catch (err) {
    if (isMissingToolTables(err)) return { ok: false, reason: "not_installed" };
    if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) return { ok: true };
    throw err;
  }
}

/**
 * The browser's read of a site the Worker was turned away from (lib/site-scan/browser-read.ts),
 * for POST /api/internal/tools/scan-pages. readSite runs over the runner's answers. While it asks
 * for an address the runner has not sent and rounds are left, nothing is written and those
 * addresses go back. Otherwise the read's facts, score and narrative replace the Worker's empty
 * ones, the read is told to the feed, and the runner goes on to match.
 */
export async function browserRead(
  db: Client,
  input: { tenantId: string; scanId: string; pages: BrowserPage[]; lastRound: boolean; now: Date; lease?: ScanLease },
): Promise<{ ok: true; need: string[] } | { ok: true; need: null; unread: string | null } | { ok: false; code: "not_wanted" }> {
  const row = await getScan(db, input.tenantId, input.scanId);
  if (!row || row.status !== "enriching" || !row.facts || !needsBrowserRead(row.facts.site)) return { ok: false, code: "not_wanted" };
  const target = siteTarget(row.url);
  if (target.kind !== "site") return { ok: false, code: "not_wanted" };

  const lines: Line[] = [];
  const say = (l: Line | Line[]) => {
    lines.push(...(Array.isArray(l) ? l : [l]));
  };
  const replay = replayRead(input.pages);
  const report = await readSite(target, { ...replay.deps, onRecord: pageRecorder(say), onPlan: (p) => say(planLine(p)) });
  if (replay.missing.size && !input.lastRound) return { ok: true, need: [...replay.missing] };

  say(healthLines(report, "The browser could not read the site either"));
  const { facts, score, narrative } = analyseRead(row.domain, report, null, input.now.toISOString(), say);
  if (!(await saveBrowserRead(db, { tenantId: input.tenantId, id: row.id, facts, score, narrative, now: input.now, lease: input.lease }))) return { ok: false, code: "not_wanted" };
  const at = input.now.toISOString();
  const events = lines.map((l) => cleanEvent({ kind: l.kind, text: l.text, data: l.data, at })).filter((e): e is CleanEvent => e !== null);
  // The read is saved; a feed that cannot take its lines is logged, never a failed read (a retry would find the read done).
  await appendEvents(db, { tenantId: input.tenantId, scanId: row.id, source: "runner", events }).catch((err: unknown) => {
    if (!eventsTableMissing(err)) console.error("[site-scan.browser-read] the feed could not take the read's lines", { scanId: row.id, error: err instanceof Error ? err.message : String(err) });
  });
  return { ok: true, need: null, unread: report.unread };
}
