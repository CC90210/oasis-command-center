/**
 * lib/tools/worker/learn-from-link.ts - "Learn from a link": read a web page
 * or a GitHub repo, write down its hook, pacing and tone, and save that as a
 * training note (a marketing_corpus row, state indexed: "Learned" on the
 * Training page), inside the request, on the workspace's own AI account.
 *
 * It writes the row in the shape the background reader writes it
 * (Business-Empire-Agent scripts/ingest_training_link.py:255-264) and with
 * that job's prompt verbatim (:116-130, system line :143), so a note made here
 * reads like any other. It never writes state 'queued': the background reader
 * claims queued rows, and this run has already read the link.
 *
 * FETCHING. Every hop goes through lib/cloud-tool-runner.ts assertSafeUrl and
 * fetchWithCap (DNS check, no automatic redirects, 5 MB cap, 15 s timeout),
 * plus ingest-core's stricter private-range check and no user, password or
 * port. Redirects are followed by hand, at most three, each hop checked again.
 * A GitHub owner/repo link reads the README from raw.githubusercontent.com
 * (README.md, readme.md, README.rst, README, in that order); api.github.com is
 * not used, its unauthenticated limit is shared by every Cloudflare egress.
 *
 * WHAT A NOTE IS NOT (yet): no agent reads these notes until the training
 * material reaches the agents; the card says only "Saved to Training
 * material."
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { assertSafeUrl, fetchWithCap } from "@/lib/cloud-tool-runner";
import { normalizeUrl } from "@/lib/founders/ingest-core";
import { INJECTION_GUARD, safeJsonExtract, wrapUntrusted } from "@/lib/llm-input-boundary";
import { runToolModelCall, type ToolModelDeps } from "@/lib/tools/worker/ai";

export type PageAnswer = { status: number; contentType: string; body: string; truncated: boolean; location: string | null };
export type PageFetch = (url: URL) => Promise<PageAnswer>;

const MAX_REDIRECTS = 3;
const MIN_READABLE_CHARS = 120;
const MODEL_TEXT_CHARS = 12_000;
const TRANSCRIPT_MAX = 50_000;
const TITLE_MAX = 200;

/** The default fetch: one capped, DNS-checked request that never follows a redirect itself. */
export const defaultPageFetch: PageFetch = (url) =>
  fetchWithCap(url, {
    method: "GET",
    headers: { "user-agent": "OASIS-Toolkit/1.0 (+https://oasisai.work)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
  });

type Fetched = { ok: true; url: string; contentType: string; body: string } | { ok: false; code: "fetch_failed" };

/** Fetch a link, following at most MAX_REDIRECTS redirects, every hop checked before it is requested. */
export async function fetchFollowing(rawUrl: string, fetchPage: PageFetch): Promise<Fetched> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let u: URL;
    try {
      u = assertSafeUrl(current);
    } catch {
      return { ok: false, code: "fetch_failed" };
    }
    if (!normalizeUrl(u.toString()) || u.username || u.password || u.port) return { ok: false, code: "fetch_failed" };
    let r: PageAnswer;
    try {
      r = await fetchPage(u);
    } catch (err) {
      console.error("[tools.learn.fetch]", { host: u.hostname, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, code: "fetch_failed" };
    }
    if (r.status >= 300 && r.status < 400) {
      if (!r.location || hop === MAX_REDIRECTS) return { ok: false, code: "fetch_failed" };
      try {
        current = new URL(r.location, u).toString();
      } catch {
        return { ok: false, code: "fetch_failed" };
      }
      continue;
    }
    if (r.status < 200 || r.status >= 300) return { ok: false, code: "fetch_failed" };
    return { ok: true, url: u.toString(), contentType: r.contentType, body: r.body };
  }
  return { ok: false, code: "fetch_failed" };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Basic HTML entities: the named five, nbsp, and numeric ones. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The readable text of an HTML page, and its title (og:title, else <title>). */
export function htmlToText(html: string): { title: string | null; text: string } {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i.exec(html);
  const tag = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const rawTitle = og?.[1] ?? tag?.[1] ?? "";
  const title = collapse(decodeEntities(rawTitle.replace(/<[^>]+>/g, " "))) || null;
  // The head (title, meta, scripts) is not the page's text; the title is kept above.
  const text = collapse(
    decodeEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(head|title|script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
  return { title, text };
}

const READABLE_TYPE = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|text\/x-rst)\b/i;
const GITHUB_PART = /^[A-Za-z0-9._-]{1,100}$/;
const README_NAMES = ["README.md", "readme.md", "README.rst", "README"];

type Page = { ok: true; title: string | null; text: string } | { ok: false; code: "fetch_failed" | "page_unreadable" };

/** One link's readable text: a repo's README, else the page. */
export async function readLink(
  input: { url: string; source_kind: string; external_id: string | null },
  fetchPage: PageFetch,
): Promise<Page> {
  const [owner, repo, extra] = (input.external_id || "").split("/");
  if (input.source_kind === "github" && owner && repo && extra === undefined && GITHUB_PART.test(owner) && GITHUB_PART.test(repo)) {
    for (const name of README_NAMES) {
      const r = await fetchFollowing(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${name}`, fetchPage);
      if (r.ok && READABLE_TYPE.test(r.contentType) && r.body.trim()) {
        return { ok: true, title: `${owner}/${repo}`, text: r.body.replace(/\r\n?/g, "\n").trim() };
      }
    }
    // No README we can read: the repo's own page still says what it is.
  }
  const r = await fetchFollowing(input.url, fetchPage);
  if (!r.ok) return r;
  if (!READABLE_TYPE.test(r.contentType)) return { ok: false, code: "page_unreadable" };
  if (/^text\/(plain|markdown|x-rst)/i.test(r.contentType)) return { ok: true, title: null, text: r.body.replace(/\r\n?/g, "\n").trim() };
  return { ok: true, ...htmlToText(r.body) };
}

/** Business-Empire-Agent scripts/ingest_training_link.py:116-130, verbatim. */
export const ANALYSIS_PROMPT = `You are analysing ONE piece of content so a marketing agent can learn its craft.

Return STRICT JSON, no prose, with exactly these keys:
  "hook"        - the first line or opening move, quoted verbatim if present
  "pacing"      - how it controls attention over time, one or two sentences
  "tone"        - the register, one or two sentences
  "structure"   - the beats in order, as a short array of strings
  "steal"       - the ONE transferable technique, one sentence
  "avoid"       - anything that would NOT transfer to a different brand, one sentence

If the text is too thin to judge any field, set that field to null. Do NOT guess.
An honest null teaches more than a confident invention.

CONTENT:
`;

/** :143, plus the input-boundary rules (the page is untrusted). */
export const ANALYSIS_SYSTEM = `You return strict JSON and nothing else. Never invent a field you cannot support from the text.\n\n${INJECTION_GUARD}`;

export type Analysis = {
  hook: string | null;
  pacing: string | null;
  tone: string | null;
  structure: string[] | null;
  steal: string | null;
  avoid: string | null;
};

const field = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : null);

/** The model's answer as an Analysis, "empty" when every field is null, or null when it is not an object. */
export function parseAnalysis(text: string): Analysis | "empty" | null {
  const parsed = safeJsonExtract(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const rawStructure = Array.isArray(o.structure) ? o.structure : typeof o.structure === "string" ? [o.structure] : [];
  const structure = rawStructure
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, 20)
    .map((s) => s.trim().slice(0, 300));
  const a: Analysis = {
    hook: field(o.hook),
    pacing: field(o.pacing),
    tone: field(o.tone),
    structure: structure.length ? structure : null,
    steal: field(o.steal),
    avoid: field(o.avoid),
  };
  return Object.values(a).every((v) => v === null) ? "empty" : a;
}

export type LearnInput = {
  url: string;
  label: string;
  source_kind: string;
  extractor: string;
  external_id: string | null;
  title: string;
};

export type LearnResult = { corpus_id: string; title: string; label: string; analysis: Analysis };

export type LearnContext = {
  db: Client;
  tenantId: string;
  userId: string | null;
  jobId: string;
  contributedBy: string;
  now: () => Date;
  ai?: ToolModelDeps;
  fetchPage?: PageFetch;
};

export type LearnCommit = { statements: InStatement[]; guard: { sql: string; args: string[] }; refusedCode: string };

const IN_FLIGHT = "state IN ('queued','extracting')";

/**
 * Read, analyse, and hand back the corpus write. The run handler commits it in
 * ONE transaction with the run's own "done", the run's update last and guarded
 * on the row this run wrote (lib/tools/store.ts finishWorkerJob).
 */
export async function runLearnFromLink(
  input: LearnInput,
  ctx: LearnContext,
): Promise<{ ok: true; result: LearnResult; commit: LearnCommit } | { ok: false; code: string }> {
  // Another read of this link is in flight (the background reader, or a drop on
  // the Training page): do not read it twice.
  const existing = await ctx.db.execute({
    sql: `SELECT id, state FROM marketing_corpus WHERE tenant_id = ? AND source_url = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
    args: [ctx.tenantId, input.url],
  });
  const rows = existing.rows.map((r) => ({ id: String(r.id), state: String(r.state) }));
  if (rows.some((r) => r.state === "queued" || r.state === "extracting")) return { ok: false, code: "already_being_read" };

  const page = await readLink(input, ctx.fetchPage ?? defaultPageFetch);
  if (!page.ok) return page;
  if (page.text.length < MIN_READABLE_CHARS) return { ok: false, code: "page_unreadable" };

  const model = await runToolModelCall(
    {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      jobId: ctx.jobId,
      surface: "tools.learn_from_link",
      system: ANALYSIS_SYSTEM,
      prompt: ANALYSIS_PROMPT + wrapUntrusted(page.text.slice(0, MODEL_TEXT_CHARS), { label: "page", maxLen: MODEL_TEXT_CHARS }),
      maxTokens: 1200,
    },
    ctx.ai,
  );
  if (!model.ok) return model;
  const analysis = parseAnalysis(model.text);
  if (analysis === null) return { ok: false, code: "ai_failed" };
  if (analysis === "empty") return { ok: false, code: "page_unreadable" };

  const at = ctx.now().toISOString();
  const title = (page.title || input.title || input.url).slice(0, TITLE_MAX);
  const extraction = JSON.stringify({
    source_kind: input.source_kind,
    extractor: input.extractor,
    external_id: input.external_id,
    analysis,
    via: "toolkit:learn_from_link",
    tool_job_id: ctx.jobId,
    model: { provider: model.provider, model: model.model },
  });
  const searchText = [analysis.hook, analysis.steal].filter(Boolean).join(" ");
  const transcript = page.text.slice(0, TRANSCRIPT_MAX);
  const jobRunning = "EXISTS (SELECT 1 FROM tool_jobs WHERE id = ? AND tenant_id = ? AND status = 'running')";
  const noReadInFlight = `NOT EXISTS (SELECT 1 FROM marketing_corpus WHERE tenant_id = ? AND source_url = ? AND ${IN_FLIGHT})`;

  // The newest finished row for this link is updated in place; none means a new row.
  const corpusId = rows[0]?.id ?? randomUUID();
  const write: InStatement = rows[0]
    ? {
        sql: `UPDATE marketing_corpus
                 SET label = ?, title = ?, transcript = ?, extraction = ?, search_text = ?, state = 'indexed',
                     attempts = attempts + 1, last_error = NULL, contributed_by = ?, updated_at = ?, indexed_at = ?
               WHERE id = ? AND tenant_id = ? AND state IN ('indexed','failed','skipped')
                 AND ${jobRunning} AND ${noReadInFlight}`,
        args: [input.label, title, transcript, extraction, searchText, ctx.contributedBy, at, at,
          corpusId, ctx.tenantId, ctx.jobId, ctx.tenantId, ctx.tenantId, input.url],
      }
    : {
        sql: `INSERT INTO marketing_corpus (id, tenant_id, kind, label, title, source_url, transcript, extraction, search_text,
                                            state, attempts, last_error, contributed_by, created_at, updated_at, indexed_at)
              SELECT ?, ?, 'link', ?, ?, ?, ?, ?, ?, 'indexed', 1, NULL, ?, ?, ?, ?
              WHERE ${jobRunning} AND ${noReadInFlight}`,
        args: [corpusId, ctx.tenantId, input.label, title, input.url, transcript, extraction, searchText, ctx.contributedBy, at, at, at,
          ctx.jobId, ctx.tenantId, ctx.tenantId, input.url],
      };
  return {
    ok: true,
    result: { corpus_id: corpusId, title, label: input.label, analysis },
    commit: {
      statements: [write],
      // The run is done only if the row it names now carries this run's id.
      guard: {
        sql: "EXISTS (SELECT 1 FROM marketing_corpus WHERE id = ? AND tenant_id = ? AND json_extract(extraction, '$.tool_job_id') = ?)",
        args: [corpusId, ctx.tenantId, ctx.jobId],
      },
      refusedCode: "already_being_read",
    },
  };
}
