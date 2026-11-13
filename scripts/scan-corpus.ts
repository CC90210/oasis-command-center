/**
 * scripts/scan-corpus.ts - the free scan's production code, end to end, on many real sites.
 *
 * WHY (CC, 2026-11-13: "make sure this never happens again ... a wide range of domains"). Two sites
 * he tried came back empty. This runs, for each site, exactly what production runs: Tier 0's read
 * and analysis (runTier0), the hand-off when a site turns the reader away, the browser's read in
 * rounds (browserRead, with the runner's real Chromium), the engine (the runner's real Python), the
 * stored report (applyEnrichReport) and the view a visitor sees (toView), against a temporary local
 * database. Nothing is written anywhere else; the directory the engine reads is read-only.
 *
 * The runner's half is BEA scripts/site_scan/corpus_worker.py, kept warm across sites.
 *
 *   node --conditions=react-server --import tsx scripts/scan-corpus.ts [--block-worker] [--out file.json] [--file sites.txt] site ...
 *
 * --block-worker  the Worker's own read is refused (HTTP 403) for every site, so every site is read
 *                 by the browser: the path a host that blocks Cloudflare's network takes.
 * BEA_ROOT        where Business-Empire-Agent is (default C:\Users\User\Business-Empire-Agent).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OASIS, applyMigrationFile, seedRunner, setupToolsDatabase } from "../tests/_tools-harness";
import { defaultSiteDeps } from "../lib/ai-audit/briefs";
import { siteTarget } from "../lib/ai-audit/site-url";
import { scanKeyOf, insertScan, getScan } from "../lib/site-scan/store";
import { runTier0, browserRead } from "../lib/site-scan/run";
import { parseBrowserPages, MAX_BROWSER_ROUNDS } from "../lib/site-scan/browser-read";
import { enrichJobInput, parseEnrichReport, applyEnrichReport } from "../lib/site-scan/enrich-job";
import { toView } from "../lib/site-scan/view";

const ROOT = join(__dirname, "..");
const BEA = process.env.BEA_ROOT || "C:\\Users\\User\\Business-Empire-Agent";
const args = process.argv.slice(2);
const blockWorker = args.includes("--block-worker");
const outAt = args.indexOf("--out");
const outFile = outAt >= 0 ? args[outAt + 1] : null;
const fileAt = args.indexOf("--file");
const fromFile = fileAt >= 0 ? readFileSync(args[fileAt + 1], "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean) : [];
const skip = new Set([...(outAt >= 0 ? [outAt, outAt + 1] : []), ...(fileAt >= 0 ? [fileAt, fileAt + 1] : [])]);
const sites = [...fromFile, ...args.filter((a, i) => !a.startsWith("--") && !skip.has(i))];

/** The runner's worker: one JSON line in, one out. */
function startWorker() {
  const python = join(BEA, ".venv", "Scripts", existsSync(join(BEA, ".venv", "Scripts", "python.exe")) ? "python.exe" : "python");
  const child = spawn(python, [join(BEA, "scripts", "site_scan", "corpus_worker.py")], { cwd: BEA, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const waiting: Array<(v: Record<string, unknown>) => void> = [];
  lines.on("line", (l) => waiting.shift()?.(JSON.parse(l)));
  const ask = (msg: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.push(resolve);
      child.stdin.write(JSON.stringify(msg) + "\n");
    });
  return { ask, stop: () => child.stdin.end() };
}

type Row = Record<string, unknown>;

type Db = Awaited<ReturnType<typeof setupToolsDatabase>>;

/** One database for the run (the test harness keeps one file per process); each site is its own scan row. */
async function setup(): Promise<Db> {
  const db = await setupToolsDatabase();
  for (const f of ["bravo__259_site_scans.sql", "bravo__260_site_scan_events.sql", "bravo__261_site_scan_screenshot.sql"]) await applyMigrationFile(db, join(ROOT, "database", "turso", f));
  await seedRunner(db, new Date(), ["site_scan_enrich"], "bea:corpus");
  return db;
}

async function scanOne(db: Db, worker: ReturnType<typeof startWorker>, input: string): Promise<Row> {
  const t0 = Date.now();
  const target = siteTarget(input);
  if (target.kind !== "site") return { input, outcome: `refused at the door: ${target.kind}${"reason" in target ? ` (${String(target.reason)})` : ""}` };
  await seedRunner(db, new Date(), ["site_scan_enrich"], "bea:corpus");
  const { row } = await insertScan(db, { tenantId: OASIS, domain: scanKeyOf(target), url: target.start, ipHash: null, now: new Date() });
  const site = blockWorker
    ? { fetch: async () => new Response("Forbidden", { status: 403, headers: { "content-type": "text/html" } }), clock: () => Date.now() }
    : defaultSiteDeps();
  const tier0 = await runTier0(db, { tenantId: OASIS, scanId: row.id }, { site, pagespeed: null, now: () => new Date() });
  const workerUnread = (await getScan(db, OASIS, row.id))?.facts?.site.unread ?? null;
  let rounds = 0;
  if (tier0.code === "browser_read") {
    const scan = (await getScan(db, OASIS, row.id))!;
    const start = scan.facts?.start_url ?? target.start;
    const u = new URL(start);
    let want = [`${u.origin}/robots.txt`, start, start.replace(/^https:/, "http:"), `http://${u.host}/robots.txt`, `${u.origin}/sitemap.xml`];
    const pages: Row[] = [];
    for (let round = 1; round <= MAX_BROWSER_ROUNDS; round++) {
      rounds = round;
      const got = await worker.ask({ cmd: "read", urls: want });
      for (const p of (got.pages as Row[]) ?? []) if (!pages.some((q) => q.url === p.url)) pages.push(p);
      const parsed = parseBrowserPages(pages);
      if (!parsed.ok) return { input, outcome: `browser pages refused: ${parsed.field}` };
      const read = await browserRead(db, { tenantId: OASIS, scanId: row.id, pages: parsed.pages, lastRound: round === MAX_BROWSER_ROUNDS, now: new Date() });
      if (!read.ok) return { input, outcome: `browser read refused: ${read.code}` };
      if (!read.need) break;
      want = read.need;
    }
  }
  const job = await enrichJobInput(db, { tenantId: OASIS, input: { scan_id: row.id } });
  let engineError: string | null = null;
  if (job.ok) {
    const answer = await worker.ask({ cmd: "enrich", input: job.input });
    if (!answer.ok) engineError = String(answer.error);
    else {
      const report = parseEnrichReport(answer.answer as Record<string, unknown>);
      if (!report.ok) engineError = `the engine's answer was refused at ${report.field}`;
      else await applyEnrichReport(db, { tenantId: OASIS, jobInput: { scan_id: row.id }, report: report.value, now: new Date() });
    }
  }
  const view = toView((await getScan(db, OASIS, row.id))!, new Date());
  const facts = view.facts;
  const enrich = view.enrich;
  const checks = facts?.checks ?? [];
  return {
    input,
    seconds: Math.round((Date.now() - t0) / 1000),
    tier0: tier0.code ?? "read",
    worker_unread: workerUnread,
    browser_rounds: rounds,
    unread: facts?.site.unread ?? null,
    note: facts?.site.notes[0] ?? null,
    pages: facts?.site.pages_read ?? 0,
    name: facts?.signals?.business_name ?? null,
    language: facts?.signals?.language ?? null,
    phones: facts?.signals?.phones?.slice(0, 2) ?? [],
    places: facts?.signals?.localities?.slice(0, 3) ?? [],
    category: enrich?.category ? `${enrich.category.label} (${Math.round(enrich.category.confidence * 100)}%)` : null,
    location: enrich?.location ? [enrich.location.locality, enrich.location.country].filter(Boolean).join(", ") : null,
    competitors: enrich?.competitors.length ?? 0,
    prospects: enrich?.prospects.length ?? 0,
    segments: enrich?.segments.length ?? 0,
    checks: `${checks.filter((c) => c.status === "yes").length}/${checks.length}`,
    score: view.score?.total ?? null,
    email: view.narrative?.email?.subject ?? null,
    engine_error: engineError,
  };
}

async function main() {
  if (!sites.length) throw new Error("name at least one site, or --file sites.txt");
  const worker = startWorker();
  const db = await setup();
  const rows: Row[] = [];
  for (const s of sites) {
    let row: Row;
    try {
      row = await scanOne(db, worker, s);
    } catch (err) {
      row = { input: s, outcome: `crashed: ${err instanceof Error ? err.message : String(err)}` };
    }
    rows.push(row);
    console.log(JSON.stringify(row));
    if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 1));
  }
  worker.stop();
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
