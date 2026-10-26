/**
 * lib/ai-audit/research.ts — the research behind a Free AI Audit, after Gate 1.
 *
 * WHEN. Only once CC has authorized the client's information (Gate 1, so the
 * engagement is in Research & Audit Generation and authorizedProfile holds),
 * started by the tick, or again by CC's press. Every phase checks that again:
 * a move back, a delete that voids the authorization, or a decline stops it.
 *
 * WHAT. One step row ("research") runs these phases, one per tick:
 *   1. site       the client's website read again, robots.txt obeyed
 *                 (lib/ai-audit/site-fetch.ts), and checked
 *                 (lib/ai-audit/site-checks.ts): our own measurement;
 *   2. pagespeed  Google PageSpeed for the home page, phone view
 *                 (lib/ai-audit/pagespeed.ts): our own measurement;
 *   3. search     web search on CC's Mac with public facts only
 *                 (lib/ai-audit/search.ts; system runner tool ai_audit_search),
 *                 skipped with a gap if no Mac takes it within six hours;
 *   4. fetch      each page it found, read by the Command Center itself, its
 *                 excerpt stored (pages behind a login are gaps);
 *   5. assemble   the profile's figures (Client-reported, as authorized), the
 *                 site's facts and likely problems (lib/ai-audit/brief.ts, the
 *                 same rules as the pre-call brief), PageSpeed's numbers, the
 *                 pages' claims, the impact calculator's estimates
 *                 (lib/ai-audit/impact.ts), and every gap. Then the evidence
 *                 rules (lib/ai-audit/evidence.ts) decide each label, and the
 *                 run is stored, frozen (ai_audit_research, bravo__243).
 * Nothing contacts the client. No figure is made up: what could not be
 * measured or read is a gap, named.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { contentHash, newId } from "@/lib/ai-audit/hash";
import type { DocEstimate, DocFinding } from "@/lib/ai-audit/doc";
import { assembleBrief } from "@/lib/ai-audit/brief";
import { formAnswers } from "@/lib/ai-audit/briefs";
import { readPage, readSite, robotsGate, type SiteReadDeps, type SiteReport } from "@/lib/ai-audit/site-fetch";
import { CHECK_TITLES, visibleText, type CheckKey, type SiteCheck } from "@/lib/ai-audit/site-checks";
import { siteTarget, type SiteTarget } from "@/lib/ai-audit/site-url";
import { runPageSpeed, type PageSpeedFetch, type PageSpeedResult } from "@/lib/ai-audit/pagespeed";
import { loginWalled, parseSearchAnswer, searchPrompt, type SearchResult } from "@/lib/ai-audit/search";
import { enforceEvidence, type EvidenceChange, type EvidenceSource } from "@/lib/ai-audit/evidence";
import { estimateImpact, validateOverrides, type AssumptionOverrides, type ImpactInputs } from "@/lib/ai-audit/impact";
import { authorizedProfile } from "@/lib/ai-audit/authorize";
import { listProfileFields } from "@/lib/ai-audit/versions";
import { PROFILE_FIELDS, profileFieldDef } from "@/lib/ai-audit/profile";
import { shortName, type AiAuditStage } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, int, readLead, requireTenant, type Actor, type Engagement } from "@/lib/ai-audit/store";
import { inputHashOf } from "@/lib/tools/store";

export const RESEARCH_SCHEMA = "ai_audit_research/v1" as const;
export const RESEARCH_STEP = "research";
export const SEARCH_TOOL_KEY = "ai_audit_search";
/** The stage research runs in: after Gate 1, before final review. */
export const RESEARCH_STAGES: readonly AiAuditStage[] = ["generating"];
/** A web search no Mac has taken in this long is skipped, with a gap. */
export const MAC_SEARCH_WAIT_MS = 6 * 3_600_000;
/** All the found pages together, read within this long. */
export const FETCH_BUDGET_MS = 25_000;
/** What one source keeps of its page: the text around each claim's figure, and the start. */
export const EXCERPT_MAX_CHARS = 1_500;

const IN_FLIGHT = ["queued", "running", "waiting_runner"];

export type ResearchSource = {
  id: string;
  kind: EvidenceSource["kind"];
  title: string;
  url: string | null;
  retrieved_at: string;
  http_status: number | null;
  content_sha256: string | null;
  /** The text this source's facts are checked against. */
  excerpt: string;
  reliability: NonNullable<EvidenceSource["reliability"]>;
  published_at: string | null;
  confirmed_note: string | null;
};

export type ResearchModule = { module: "profile" | "site" | "pagespeed" | "search"; status: "done" | "partial" | "skipped" | "failed"; detail: string };

export type ResearchPack = {
  schema: typeof RESEARCH_SCHEMA;
  built_at: string;
  business: { name: string; type: string | null; website: string | null; city: string | null };
  plan: ResearchModule[];
  sources: ResearchSource[];
  findings: DocFinding[];
  /** The calculator's inputs, kept so the estimates can be recomputed with CC's own ranges. */
  impact_inputs: ImpactInputs;
  estimates: DocEstimate[];
  gaps: Array<{ topic: string; why: string }>;
  evidence_changes: EvidenceChange[];
  search_refused: string[];
};

export type StoredResearch = { id: string; version_no: number; status: "ready" | "partial"; content: ResearchPack; content_sha256: string; created_at: string };

type SiteState = { target: SiteTarget; checks: SiteCheck[]; pagesRead: number; notes: string[]; unread: SiteReport["unread"]; sources: ResearchSource[] } | { skipped: string };
type State = {
  phase: "site" | "pagespeed" | "search" | "waiting_search" | "fetch" | "assemble";
  site?: SiteState;
  pagespeed?: PageSpeedResult | { skipped: string };
  search?: { job_id: string | null; queued_at: string | null; results?: SearchResult[]; refused?: string[]; note?: string };
  fetched?: Array<{ index: number; source: ResearchSource | null; gap: string | null }>;
};

export type ResearchDeps = {
  site: SiteReadDeps;
  pagespeed: { fetch: PageSpeedFetch; key: string | null };
  alert: (input: { tenantId: string; alertType: string; severity: "info" | "warn" | "urgent"; title: string; body: string; subjectType: string; subjectId: string }) => Promise<unknown>;
};

export function defaultPageSpeedDeps(): ResearchDeps["pagespeed"] {
  return { fetch: (url, init) => fetch(url, init), key: (process.env.PAGESPEED_API_KEY || "").trim() || null };
}

export async function researchTablesInstalled(db: Client): Promise<boolean> {
  try {
    await db.execute("SELECT (SELECT COUNT(*) FROM ai_audit_research WHERE 0) AS r, (SELECT COUNT(*) FROM ai_audit_assumptions WHERE 0) AS a");
    return true;
  } catch (err) {
    if (/no such table|no such column/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

function parsePack(raw: unknown): ResearchPack | null {
  try {
    const v = JSON.parse(String(raw ?? "")) as ResearchPack;
    return v && v.schema === RESEARCH_SCHEMA ? v : null;
  } catch {
    return null;
  }
}

export async function latestResearch(db: Client, tenantId: string, engagementId: string): Promise<StoredResearch | null> {
  const t = requireTenant(tenantId);
  const r = (
    await db.execute({ sql: "SELECT id, version_no, status, content, content_sha256, created_at FROM ai_audit_research WHERE tenant_id = ? AND engagement_id = ? ORDER BY version_no DESC LIMIT 1", args: [t, engagementId] })
  ).rows[0];
  const content = r ? parsePack(r.content) : null;
  if (!r || !content) return null;
  return { id: String(r.id), version_no: int(r.version_no), status: String(r.status) === "partial" ? "partial" : "ready", content, content_sha256: String(r.content_sha256), created_at: String(r.created_at) };
}

/** CC's own assumption ranges for the engagement, or none. */
export async function assumptionOverrides(db: Client, tenantId: string, engagementId: string): Promise<AssumptionOverrides> {
  const r = (await db.execute({ sql: "SELECT overrides_json FROM ai_audit_assumptions WHERE tenant_id = ? AND engagement_id = ? LIMIT 1", args: [requireTenant(tenantId), engagementId] })).rows[0];
  if (!r) return {};
  try {
    const v = validateOverrides(JSON.parse(String(r.overrides_json)));
    return v.ok ? v.value : {};
  } catch {
    return {};
  }
}

export async function saveAssumptions(db: Client, input: { tenantId: string; engagementId: string; overrides: unknown; actor: Actor; now: Date }): Promise<{ ok: true; overrides: AssumptionOverrides } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const v = validateOverrides(input.overrides);
  if (!v.ok) return v;
  const at = input.now.toISOString();
  await db.batch(
    [
      {
        sql: `INSERT INTO ai_audit_assumptions (tenant_id, engagement_id, overrides_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (tenant_id, engagement_id) DO UPDATE SET overrides_json = excluded.overrides_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        args: [t, input.engagementId, JSON.stringify(v.value), input.actor.id, at],
      },
      eventStatement({ tenantId: t, engagementId: input.engagementId, event: "assumptions_saved", actor: input.actor, at, meta: { keys: Object.keys(v.value) } }),
    ],
    "write",
  );
  return { ok: true, overrides: v.value };
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export type StartResearchResult = { ok: true; stepId: string; created: boolean } | { ok: false; error: "not_found" | "stage_closed" | "not_authorized" | "not_installed" };

export async function startResearch(db: Client, input: { tenantId: string; engagementId: string; actor: Actor; now: Date }): Promise<StartResearchResult> {
  const t = requireTenant(input.tenantId);
  if (!(await researchTablesInstalled(db))) return { ok: false, error: "not_installed" };
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!RESEARCH_STAGES.includes(e.stage)) return { ok: false, error: "stage_closed" };
  if (!(await authorizedProfile(db, t, e))) return { ok: false, error: "not_authorized" };
  const running = (
    await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner') LIMIT 1", args: [t, e.id, RESEARCH_STEP] })
  ).rows[0];
  if (running) return { ok: true, stepId: String(running.id), created: false };
  const runNo = int((await db.execute({ sql: "SELECT COUNT(1) AS n FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ?", args: [t, e.id, RESEARCH_STEP] })).rows[0]?.n) + 1;
  const stepId = newId();
  const at = input.now.toISOString();
  const state: State = { phase: "site" };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO ai_audit_steps (id, tenant_id, engagement_id, step_key, run_no, runs_on, status, input_hash, idempotency_key, max_attempts, result_ref, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'cloud', 'queued', ?, ?, 3, ?, ?, ?)`,
          args: [stepId, t, e.id, RESEARCH_STEP, runNo, contentHash({ engagement: e.id, run: runNo }), `research:${e.id}:${runNo}`, JSON.stringify(state), at, at],
        },
        eventStatement({ tenantId: t, engagementId: e.id, event: "research_started", actor: input.actor, at, refType: "step", refId: stepId }),
      ],
      "write",
    );
  } catch (err) {
    // Two starts at once: the one that lost hands back the run that won.
    if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
      const won = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner') LIMIT 1", args: [t, e.id, RESEARCH_STEP] })).rows[0];
      if (won) return { ok: true, stepId: String(won.id), created: false };
    }
    throw err;
  }
  return { ok: true, stepId, created: true };
}

// ---------------------------------------------------------------------------
// The Mac's web search: its prompt at claim time, its checked answer
// ---------------------------------------------------------------------------

/** What the Mac is handed: the prompt, built now from public facts only. */
export async function searchJobInput(db: Client, job: { tenantId: string; input: Record<string, unknown> }): Promise<{ ok: true; input: Record<string, unknown> } | { ok: false; code: "gone" | "not_permitted" | "bad_input" }> {
  const t = requireTenant(job.tenantId);
  const stepId = typeof job.input.step_id === "string" ? job.input.step_id : "";
  const engagementId = typeof job.input.engagement_id === "string" ? job.input.engagement_id : "";
  if (!stepId || !engagementId) return { ok: false, code: "bad_input" };
  const step = (await db.execute({ sql: "SELECT status FROM ai_audit_steps WHERE tenant_id = ? AND id = ? AND engagement_id = ? LIMIT 1", args: [t, stepId, engagementId] })).rows[0];
  if (!step || !IN_FLIGHT.includes(String(step.status))) return { ok: false, code: "gone" };
  const e = await getEngagement(db, t, engagementId);
  if (!e || !RESEARCH_STAGES.includes(e.stage) || !(await authorizedProfile(db, t, e))) return { ok: false, code: "not_permitted" };
  const lead = await readLead(db, t, e.lead_id);
  const p = searchPrompt({ businessName: e.business_name || lead?.businessName || "", website: lead?.website ?? null, city: lead?.city ?? null, businessType: e.business_type });
  return { ok: true, input: { purpose: "search", system: p.system, prompt: p.prompt, model: "sonnet", max_turns: 12 } };
}

/** The Mac's answer, checked: what the job keeps (public pages and claims only). */
export function checkSearchAnswer(text: string): { results: SearchResult[]; refused: string[]; unreadable: boolean } {
  const r = parseSearchAnswer(text);
  return r.ok ? { results: r.results, refused: r.refused, unreadable: false } : { results: [], refused: [], unreadable: true };
}

// ---------------------------------------------------------------------------
// One phase per call
// ---------------------------------------------------------------------------

const RELIABLE_HOSTS = /(\.gov|\.gov\.[a-z]{2}|\.gc\.ca|\.edu|\.ac\.[a-z]{2}|(^|\.)statcan\.gc\.ca|(^|\.)bls\.gov|(^|\.)census\.gov|(^|\.)oecd\.org)$/i;
const MEDIUM_HOSTS = /(\.org|(^|\.)statista\.com|(^|\.)ibisworld\.com|(^|\.)pewresearch\.org|(^|\.)hbr\.org)$/i;
function reliabilityOf(u: URL): ResearchSource["reliability"] {
  if (RELIABLE_HOSTS.test(u.hostname)) return "high";
  if (MEDIUM_HOSTS.test(u.hostname)) return "medium";
  return "low";
}

/** A page's publication date, when it says one (meta tags or structured data); never guessed. */
function publishedAt(html: string): string | null {
  const m =
    /<meta[^>]{0,200}(?:property|name)=["'](?:article:published_time|datePublished|date|dc\.date)["'][^>]{0,200}content=["']([^"']{8,40})["']/i.exec(html.slice(0, 200_000)) ??
    /"datePublished"\s{0,3}:\s{0,3}"([^"]{8,40})"/.exec(html.slice(0, 400_000));
  if (!m) return null;
  const at = Date.parse(m[1]);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** The page's text around each claim's figure, and its first lines: what the evidence rules check claims against. */
function excerptFor(text: string, claims: SearchResult["claims"]): string {
  const parts: string[] = [text.slice(0, 400)];
  for (const c of claims) {
    if (c.value === null) continue;
    const needle = String(c.value);
    const at = text.indexOf(needle);
    if (at >= 0) parts.push(text.slice(Math.max(0, at - 150), at + needle.length + 150));
  }
  return parts.join(" ... ").replace(/\s+/g, " ").slice(0, EXCERPT_MAX_CHARS);
}

async function failStep(db: Client, t: string, stepId: string, code: string, now: Date) {
  await db.execute({
    sql: "UPDATE ai_audit_steps SET status = 'cancelled', error_code = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
    args: [code, now.toISOString(), now.toISOString(), t, stepId],
  });
  // A search still waiting on the Mac is called off with it.
  await db.execute({
    sql: `UPDATE tool_jobs SET status = 'failed', error_code = 'ai_audit_gone', finished_at = ?, updated_at = ? WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ? AND status IN ('queued', 'claimed', 'running')`,
    args: [now.toISOString(), now.toISOString(), t, SEARCH_TOOL_KEY, stepId],
  });
}

async function saveState(db: Client, t: string, stepId: string, state: State, status: "running" | "waiting_runner", now: Date): Promise<boolean> {
  const r = await db.execute({
    sql: "UPDATE ai_audit_steps SET status = ?, result_ref = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
    args: [status, JSON.stringify(state), now.toISOString(), t, stepId],
  });
  return r.rowsAffected === 1;
}

export type AdvanceResult = "advanced" | "waiting" | "finished" | "failed" | "idle";

/** One phase of one run. Each re-checks that the run may go on; the last stores the research. */
export async function advanceResearch(db: Client, input: { tenantId: string; stepId: string; now: Date; deps: ResearchDeps }): Promise<AdvanceResult> {
  const t = requireTenant(input.tenantId);
  const row = (await db.execute({ sql: "SELECT id, engagement_id, status, result_ref FROM ai_audit_steps WHERE tenant_id = ? AND id = ? AND step_key = ? LIMIT 1", args: [t, input.stepId, RESEARCH_STEP] })).rows[0];
  if (!row || !IN_FLIGHT.includes(String(row.status))) return "idle";
  const e = await getEngagement(db, t, String(row.engagement_id));
  if (!e || !RESEARCH_STAGES.includes(e.stage)) {
    await failStep(db, t, input.stepId, "stage_closed", input.now);
    return "failed";
  }
  if (!(await authorizedProfile(db, t, e))) {
    await failStep(db, t, input.stepId, "not_authorized", input.now);
    return "failed";
  }
  let state: State;
  try {
    state = JSON.parse(String(row.result_ref ?? "{}")) as State;
    if (!state.phase) state = { phase: "site" };
  } catch {
    state = { phase: "site" };
  }
  const lead = await readLead(db, t, e.lead_id);
  const target = siteTarget(lead?.website ?? null);

  if (state.phase === "site") {
    if (target.kind !== "site") {
      state.site = { skipped: target.kind === "social" ? `The business's web address is a ${target.platform} page, not a website.` : "No website is known for the business." };
    } else {
      const report = await readSite(target, input.deps.site);
      const at = input.now.toISOString();
      const pages = report.pages.filter((p) => p.kind === "site_page");
      const sources: ResearchSource[] = pages
        .filter((p) => !p.error && p.status !== null && p.status >= 200 && p.status < 300)
        .slice(0, 9)
        .map((p, i) => ({
          id: `s-site-${i + 1}`,
          kind: "measurement",
          title: `${p.title || new URL(p.finalUrl ?? p.url).hostname}, read by the Command Center`,
          url: p.finalUrl ?? p.url,
          retrieved_at: at,
          http_status: p.status,
          content_sha256: p.html ? contentHash(p.html) : null,
          excerpt: p.html ? visibleText(p.html).replace(/\s+/g, " ").slice(0, EXCERPT_MAX_CHARS) : "",
          reliability: "own_measurement",
          published_at: null,
          confirmed_note: null,
        }));
      const pagesRead = sources.length;
      state.site = { target, checks: report.checks, pagesRead, notes: report.notes, unread: report.unread, sources };
    }
    state.phase = "pagespeed";
    return (await saveState(db, t, input.stepId, state, "running", input.now)) ? "advanced" : "idle";
  }

  if (state.phase === "pagespeed") {
    const home = state.site && "target" in state.site && state.site.target.kind === "site" && state.site.pagesRead > 0 ? state.site.target.start : null;
    state.pagespeed = home ? await runPageSpeed(home, { fetch: input.deps.pagespeed.fetch, key: input.deps.pagespeed.key, now: () => input.now }) : { skipped: "No page of the website was read, so PageSpeed was not run." };
    state.phase = "search";
    return (await saveState(db, t, input.stepId, state, "running", input.now)) ? "advanced" : "idle";
  }

  if (state.phase === "search") {
    const jobId = newId();
    const at = input.now.toISOString();
    const jobInput = { step_id: input.stepId, engagement_id: e.id };
    state.search = { job_id: jobId, queued_at: at };
    state.phase = "waiting_search";
    await db.batch(
      [
        {
          sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 'runner', 'queued', ?, ?, ?, ?, ?)`,
          args: [jobId, t, SEARCH_TOOL_KEY, JSON.stringify(jobInput), inputHashOf(SEARCH_TOOL_KEY, jobInput), `${SEARCH_TOOL_KEY}:${input.stepId}`, at, at],
        },
        {
          sql: "UPDATE ai_audit_steps SET status = 'waiting_runner', result_ref = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running')",
          args: [JSON.stringify(state), at, t, input.stepId],
        },
      ],
      "write",
    );
    return "advanced";
  }

  if (state.phase === "waiting_search") {
    const job = state.search?.job_id
      ? (await db.execute({ sql: "SELECT status, result_json, error_code, created_at FROM tool_jobs WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, state.search.job_id] })).rows[0]
      : null;
    if (job && String(job.status) === "done") {
      let parsed: { search?: { results?: SearchResult[]; refused?: string[]; unreadable?: boolean } } = {};
      try {
        parsed = JSON.parse(String(job.result_json ?? "{}"));
      } catch {
        parsed = {};
      }
      state.search = { ...state.search!, results: parsed.search?.results ?? [], refused: parsed.search?.refused ?? [], note: parsed.search?.unreadable ? "The web search's answer could not be read." : undefined };
    } else if (job && String(job.status) === "failed") {
      state.search = { ...state.search!, results: [], note: `The web search on the Mac failed (${String(job.error_code ?? "error")}).` };
    } else if (!job || input.now.getTime() - Date.parse(String(job.created_at)) > MAC_SEARCH_WAIT_MS) {
      if (job) {
        await db.execute({
          sql: "UPDATE tool_jobs SET status = 'failed', error_code = 'runner_offline', finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'queued'",
          args: [input.now.toISOString(), input.now.toISOString(), t, state.search!.job_id],
        });
      }
      state.search = { ...(state.search ?? { job_id: null, queued_at: null }), results: [], note: "No Mac ran the web search within six hours, so the research has no web search." };
    } else {
      return "waiting";
    }
    state.phase = "fetch";
    return (await saveState(db, t, input.stepId, state, "running", input.now)) ? "advanced" : "idle";
  }

  if (state.phase === "fetch") {
    const results = state.search?.results ?? [];
    const deadline = input.deps.site.clock() + FETCH_BUDGET_MS;
    // Each site's robots.txt is asked first: a page it closes to automated reading is a gap, not read.
    const mayRead = robotsGate(input.deps.site, deadline);
    const fetched: NonNullable<State["fetched"]> = [];
    const at = input.now.toISOString();
    for (const [index, r] of results.entries()) {
      let u: URL;
      try {
        u = new URL(r.url);
      } catch {
        continue;
      }
      if (loginWalled(u)) {
        fetched.push({ index, source: null, gap: `${u.hostname.replace(/^www\./, "")} could not be read without a login, so what it shows is not in the research.` });
        continue;
      }
      if (input.deps.site.clock() >= deadline) {
        fetched.push({ index, source: null, gap: `${u.hostname} was not read: the time for reading pages ran out.` });
        continue;
      }
      const read = await readPage(r.url, input.deps.site, { accept: "html", deadline, mayRead });
      if (!read.ok) {
        const host = u.hostname.replace(/^www\./, "");
        const why =
          read.error === "robots_closed"
            ? `${host} does not allow automated reading (its robots.txt), so what it shows is not in the research.`
            : read.error === "robots_unreadable"
              ? `${host}'s robots.txt could not be read, so its page was not read.`
              : `${host} could not be read (${read.error}).`;
        fetched.push({ index, source: null, gap: why });
        continue;
      }
      const text = visibleText(read.page.html);
      fetched.push({
        index,
        gap: null,
        source: {
          id: `s-web-${index + 1}`,
          kind: r.kind === "industry" ? "publication" : r.kind === "social" ? "other" : "listing",
          title: r.title,
          url: read.page.finalUrl,
          retrieved_at: at,
          http_status: read.page.status,
          content_sha256: contentHash(read.page.html),
          excerpt: excerptFor(text, r.claims),
          reliability: r.kind === "industry" ? reliabilityOf(new URL(read.page.finalUrl)) : "low",
          published_at: publishedAt(read.page.html),
          confirmed_note: null,
        },
      });
    }
    state.fetched = fetched;
    state.phase = "assemble";
    return (await saveState(db, t, input.stepId, state, "running", input.now)) ? "advanced" : "idle";
  }

  // assemble
  const pack = await assemblePack(db, t, e, lead, state, input.now);
  const versionNo = int((await db.execute({ sql: "SELECT COALESCE(MAX(version_no), 0) AS n FROM ai_audit_research WHERE tenant_id = ? AND engagement_id = ?", args: [t, e.id] })).rows[0]?.n) + 1;
  const id = newId();
  const at = input.now.toISOString();
  const partial = pack.plan.some((m) => m.status !== "done");
  const system: Actor = { type: "system", id: null };
  const done = await db.execute({
    sql: "UPDATE ai_audit_steps SET status = 'done', result_ref = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
    args: [JSON.stringify({ research_id: id, findings: pack.findings.length, sources: pack.sources.length, gaps: pack.gaps.length }), at, at, t, input.stepId],
  });
  if (done.rowsAffected !== 1) return "idle";
  await db.batch(
    [
      {
        sql: "INSERT INTO ai_audit_research (id, tenant_id, engagement_id, version_no, status, content, content_sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        args: [id, t, e.id, versionNo, partial ? "partial" : "ready", JSON.stringify(pack), contentHash(pack), at],
      },
      eventStatement({ tenantId: t, engagementId: e.id, event: "research_done", actor: system, at, refType: "research", refId: id, meta: { version_no: versionNo, findings: pack.findings.length, gaps: pack.gaps.length } }),
    ],
    "write",
  );
  await input.deps.alert({
    tenantId: t,
    alertType: "ai_audit_research_ready",
    severity: "info",
    title: `Research ready: ${shortName(e.business_name, "an AI audit")}`,
    body: `${pack.findings.length} finding${pack.findings.length === 1 ? "" : "s"} from ${pack.sources.length} source${pack.sources.length === 1 ? "" : "s"}${pack.gaps.length ? `, ${pack.gaps.length} gap${pack.gaps.length === 1 ? "" : "s"} named` : ""}. Open the engagement to read it.`,
    subjectType: "ai_audit_engagement",
    subjectId: e.id,
  });
  return "finished";
}

// ---------------------------------------------------------------------------
// Assembling
// ---------------------------------------------------------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const fid = (prefix: string, key: string) => `${prefix}-${slug(key)}`.slice(0, 32).replace(/-+$/, "");

function valueWords(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? Object.values(x as Record<string, unknown>).filter((y) => y !== null && y !== "").join(", ") : String(x))).join("; ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

async function assemblePack(db: Client, t: string, e: Engagement, lead: Awaited<ReturnType<typeof readLead>>, state: State, now: Date): Promise<ResearchPack> {
  const sources: ResearchSource[] = [];
  const findings: DocFinding[] = [];
  const gaps: ResearchPack["gaps"] = [];
  const plan: ResearchModule[] = [];
  const at = now.toISOString();

  // 1. The profile, as CC authorized it: each figure Client-reported (or Verified, where CC verified it with a note).
  const fields = e.current_profile_version_id ? await listProfileFields(db, t, e.current_profile_version_id) : [];
  const impactInputs: ImpactInputs = {};
  for (const f of fields) {
    const def = profileFieldDef(f.field_key);
    if (!def || def.group === "consent" || f.value === null || f.value === undefined || f.value === "") continue;
    const ref = f.source_ref as { from?: number; to?: number; note?: string };
    const sourceId = fid("s-client", f.field_key);
    const where =
      f.source_type === "transcript" && typeof ref.from === "number"
        ? `Discovery call transcript, lines ${ref.from}${ref.to && ref.to !== ref.from ? `-${ref.to}` : ""}`
        : f.source_type === "call_notes"
          ? "CC's notes from the discovery call"
          : f.source_type === "form"
            ? "The client's audit form"
            : "Entered by CC";
    sources.push({
      id: sourceId,
      kind: f.label === "verified" ? "other" : "client",
      title: where,
      url: null,
      retrieved_at: at,
      http_status: null,
      content_sha256: null,
      // Never the call's own words: a stored research run is frozen, and a transcript delete must be able to
      // reach every quote from it. The profile keeps the quote; the research keeps where it came from.
      excerpt: "",
      reliability: "client_stated",
      published_at: null,
      confirmed_note: f.label === "verified" ? (f.verified_note ?? null) : null,
    });
    const isFigure = (def.type === "number" || def.type === "money") && typeof f.value === "number";
    findings.push({
      id: fid("f", f.field_key),
      title: def.label,
      statement: `${def.label}: ${valueWords(f.value)}${def.unit && isFigure ? ` ${def.unit}` : ""}.`,
      label: f.label === "verified" ? "verified" : f.label === "hypothesis" ? "hypothesis" : "client_reported",
      ...(isFigure ? { metric: { value: f.value as number, unit: def.type === "money" ? "$" : (def.unit ?? "") } } : {}),
      source_ids: [sourceId],
      ...(f.label === "hypothesis" ? { how_to_test: "Check it with the client before it is used." } : {}),
    });
    if (isFigure && f.field_key in IMPACT_KEYS) {
      impactInputs[f.field_key as keyof ImpactInputs] = { value: f.value as number, label: f.label === "verified" ? "verified" : "client_reported", sourceId };
    }
  }
  plan.push({ module: "profile", status: fields.length ? "done" : "partial", detail: `${fields.filter((f) => profileFieldDef(f.field_key)?.group !== "consent").length} answers from the discovery profile, as authorized.` });
  for (const def of PROFILE_FIELDS) {
    if (def.needed_for_estimates && !fields.some((f) => f.field_key === def.key)) gaps.push({ topic: def.label, why: "The discovery profile does not have it." });
  }

  // 2. The website, and what it suggests: the pre-call brief's own rules, on this fresh read.
  const site = state.site;
  if (site && "target" in site) {
    const brief = assembleBrief({
      builtAt: at,
      business: { name: e.business_name || "", type: e.business_type },
      form: lead ? await formAnswers(db, t, lead.id) : null,
      site: { target: site.target, checks: site.checks, pagesRead: site.pagesRead, notes: site.notes, unread: site.unread },
    });
    sources.push(...site.sources);
    const home = site.sources[0]?.id ?? null;
    for (const fact of brief.facts) {
      const from = fact.source;
      if (from.kind !== "site") continue;
      const check = from.check as CheckKey;
      const src = site.sources.find((s) => s.url === from.url) ?? (home ? site.sources[0] : null);
      findings.push({ id: fid("f-site", check), title: CHECK_TITLES[check], statement: fact.statement, label: "verified", source_ids: src ? [src.id] : [] });
    }
    for (const h of brief.hypotheses) findings.push({ id: fid("h", h.id), title: "Likely problem", statement: h.statement, label: "hypothesis", source_ids: home ? [home] : [], how_to_test: h.test });
    for (const g of brief.gaps) gaps.push({ topic: "Website", why: g });
    plan.push({ module: "site", status: site.pagesRead ? (site.unread ? "partial" : "done") : "failed", detail: `${site.pagesRead} page${site.pagesRead === 1 ? "" : "s"} of the website read.` });
  } else {
    gaps.push({ topic: "Website", why: site && "skipped" in site ? site.skipped : "The website was not read." });
    plan.push({ module: "site", status: "skipped", detail: site && "skipped" in site ? site.skipped : "Not read." });
  }

  // 3. PageSpeed.
  const ps = state.pagespeed;
  if (ps && "ok" in ps && ps.ok) {
    const sid = "s-pagespeed";
    sources.push({ id: sid, kind: "measurement", title: "Google PageSpeed Insights, phone view", url: ps.final_url ?? ps.url, retrieved_at: ps.fetched_at, http_status: 200, content_sha256: null, excerpt: JSON.stringify({ scores: ps.scores, timings: ps.timings }).slice(0, EXCERPT_MAX_CHARS), reliability: "own_measurement", published_at: null, confirmed_note: null });
    const score = (key: keyof typeof ps.scores, title: string) => {
      const v = ps.scores[key];
      if (v !== null) findings.push({ id: fid("f-ps", key), title, statement: `Google PageSpeed scores the home page ${v} out of 100 for ${title.toLowerCase()} on a phone.`, label: "verified", metric: { value: v, unit: "/100" }, source_ids: [sid] });
    };
    score("performance", "Speed");
    score("accessibility", "Accessibility");
    score("seo", "Search basics");
    if (ps.timings.lcp_ms !== null) {
      const s = Math.round(ps.timings.lcp_ms / 100) / 10;
      findings.push({ id: "f-ps-lcp", title: "Time to the main content", statement: `On a phone, the home page's main content takes ${s} seconds to appear.`, label: "verified", metric: { value: s, unit: "seconds" }, source_ids: [sid] });
    }
    plan.push({ module: "pagespeed", status: "done", detail: "Google PageSpeed was run for the home page." });
  } else {
    const why = ps && "skipped" in ps ? ps.skipped : ps && "detail" in ps ? `PageSpeed could not be run: ${ps.detail}.` : "PageSpeed was not run.";
    gaps.push({ topic: "Website speed", why });
    plan.push({ module: "pagespeed", status: ps && "skipped" in ps ? "skipped" : "failed", detail: why });
  }

  // 4. What the web search found, as the pages themselves state it.
  const results = state.search?.results ?? [];
  if (state.search?.note) gaps.push({ topic: "Web search", why: state.search.note });
  let claimN = 0;
  for (const f of state.fetched ?? []) {
    if (f.gap) gaps.push({ topic: "Web search", why: f.gap });
    const r = results[f.index];
    if (!f.source || !r) continue;
    sources.push(f.source);
    for (const c of r.claims) {
      claimN += 1;
      findings.push({
        id: `f-web-${claimN}`.slice(0, 32),
        title: r.kind === "competitor" ? `A competitor: ${r.title}`.slice(0, 200) : r.title.slice(0, 200),
        statement: c.text,
        label: "verified",
        ...(c.value !== null ? { metric: { value: c.value, unit: c.unit ?? "" } } : {}),
        source_ids: [f.source.id],
      });
    }
  }
  plan.push({
    module: "search",
    status: state.search?.note ? (results.length ? "partial" : "skipped") : "done",
    detail: state.search?.note ?? `${results.length} page${results.length === 1 ? "" : "s"} found, ${(state.fetched ?? []).filter((x) => x.source).length} read.`,
  });

  // 5. The evidence rules decide every label; then the estimates.
  const evidence = enforceEvidence(
    findings,
    sources.map((s) => ({ id: s.id, kind: s.kind, text: s.excerpt, reliability: s.reliability, published_at: s.published_at, confirmed_note: s.confirmed_note })),
    now,
  );
  const overrides = await assumptionOverrides(db, t, e.id);
  const impact = estimateImpact(impactInputs, overrides);
  gaps.push(...impact.gaps);
  return {
    schema: RESEARCH_SCHEMA,
    built_at: at,
    business: { name: e.business_name || "", type: e.business_type, website: lead?.website ?? null, city: lead?.city ?? null },
    plan,
    sources,
    findings: evidence.findings,
    impact_inputs: impactInputs,
    estimates: impact.estimates,
    gaps: gaps.slice(0, 30),
    evidence_changes: evidence.changes,
    search_refused: state.search?.refused ?? [],
  };
}

const IMPACT_KEYS: Readonly<Record<keyof ImpactInputs, true>> = {
  "sales.missed_calls_per_week": true,
  "sales.close_rate_pct": true,
  "sales.avg_job_value": true,
  "ops.admin_hours_per_week": true,
  "finance.staff_hourly_cost": true,
  "sales.leads_per_month": true,
  "sales.response_time_hours": true,
};

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** Engagements in research with no run yet (to start), and runs in flight (to advance). */
export async function dueResearch(db: Client, tenantId: string): Promise<{ start: string[]; advance: string[] }> {
  const t = requireTenant(tenantId);
  if (!(await researchTablesInstalled(db))) return { start: [], advance: [] };
  const start = await db.execute({
    sql: `SELECT e.id FROM ai_audit_engagements e WHERE e.tenant_id = ? AND e.stage IN (${RESEARCH_STAGES.map(() => "?").join(", ")})
            AND NOT EXISTS (SELECT 1 FROM ai_audit_research r WHERE r.tenant_id = e.tenant_id AND r.engagement_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM ai_audit_steps s WHERE s.tenant_id = e.tenant_id AND s.engagement_id = e.id AND s.step_key = ? AND (s.status IN ('queued', 'running', 'waiting_runner') OR s.created_at > ?))
          ORDER BY e.updated_at LIMIT 2`,
    // A run that ended in the last hour is not started again by the tick (CC can press Research again).
    args: [t, ...RESEARCH_STAGES, RESEARCH_STEP, new Date(Date.now() - 3_600_000).toISOString()],
  });
  const advance = await db.execute({
    sql: "SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner') ORDER BY updated_at LIMIT 3",
    args: [t, RESEARCH_STEP],
  });
  return { start: start.rows.map((r) => String(r.id)), advance: advance.rows.map((r) => String(r.id)) };
}

/** The latest run's status, for the engagement page. */
export async function latestResearchStep(db: Client, tenantId: string, engagementId: string): Promise<{ id: string; status: string; phase: string | null; error: string | null; created_at: string } | null> {
  const r = (await db.execute({ sql: "SELECT id, status, result_ref, error_code, created_at FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? ORDER BY created_at DESC LIMIT 1", args: [requireTenant(tenantId), engagementId, RESEARCH_STEP] })).rows[0];
  if (!r) return null;
  let phase: string | null = null;
  try {
    phase = (JSON.parse(String(r.result_ref ?? "{}")) as { phase?: string }).phase ?? null;
  } catch {
    phase = null;
  }
  return { id: String(r.id), status: String(r.status), phase, error: r.error_code === null || r.error_code === undefined ? null : String(r.error_code), created_at: String(r.created_at) };
}
