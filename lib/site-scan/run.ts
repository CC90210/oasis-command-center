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
import { getScan, saveTier0, setStatus } from "@/lib/site-scan/store";
import { EventSink, NO_EVENTS, type ScanEvents } from "@/lib/site-scan/events";
import { checkLines, pageLine, planLine, scoreLines, signalLines, speedLine, type Line } from "@/lib/site-scan/live";
import { FACTS_SCHEMA, type ScanFacts } from "@/lib/site-scan/types";

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
  // robots.txt is asked once per address the site answers on (https, www, http); the reader is
  // told about it once.
  let robotsSaid = false;
  const onRecord = (r: PageRecord) => {
    if (r.kind === "robots_txt" && r.error === null) {
      if (robotsSaid) return;
      robotsSaid = true;
    }
    say(pageLine(r));
  };
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
  if (report.unread) say({ kind: "error", text: report.notes[0] ?? "Nothing on the site could be read" });
  else say(checkLines(report.checks));

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

  const facts = factsFrom({ domain: row.domain, report, pagespeed, readAt: deps.now().toISOString() });
  say(signalLines(facts.signals));
  const score = scoreFacts(facts);
  say(scoreLines(score));
  const narrative = baseNarrative(facts, score);

  // A site that could not be read at all is finished here: there is nothing for the runner to enrich.
  if (report.unread) {
    await saveTier0(db, { tenantId: input.tenantId, id: row.id, facts, score, narrative, status: "done", stage: "done", now: deps.now() });
    say({ kind: "done", text: "Report ready" });
    return { ok: true, code: "unread" };
  }

  const saved = await saveTier0(db, { tenantId: input.tenantId, id: row.id, facts, score, narrative, status: "enriching", stage: "profile", now: deps.now() });
  if (!saved) return { ok: false, code: "status_changed" };

  const queued = await queueEnrichment(db, { tenantId: input.tenantId, scanId: row.id, now: deps.now() });
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

export async function queueEnrichment(db: Client, input: { tenantId: string; scanId: string; now: Date }): Promise<{ ok: true } | { ok: false; reason: string }> {
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
        idempotencyKey: `${ENRICH_TOOL_KEY}:${input.scanId}`,
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
