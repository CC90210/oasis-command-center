/**
 * lib/ai-audit/briefs.ts — building, storing and reading the pre-call brief.
 *
 * A brief is built from the lead's own website (read by site-fetch.ts) and the
 * answers the client gave on the AI-audit form (lead_interactions, written by
 * lib/forms/ai-audit-ingest.ts), and put together by code (brief.ts). Each
 * build is a new, unchangeable version (bravo__241's trigger), with one source
 * row per request the read made (each page, robots.txt, the sitemap, the
 * plain-HTTP check) and one for the form answers: what was read, when, its
 * hash and a short excerpt, never the page itself. Every Verified fact rests
 * on one of those rows.
 *
 * When it runs: once by itself when the engagement reaches Research in
 * Progress or Meeting booked (the tick, which marks each try first
 * and waits between tries), and whenever CC presses "Build the brief" before
 * Gate 1. After Gate 1 the brief is history: the audit's research takes over
 * (phase 3).
 *
 * Only the brief needs bravo__241: until it is applied, building answers
 * not_installed and the pages show no brief, and the rest of the audit runs.
 *
 * Nothing here contacts the client or sends the client's information to any
 * AI service. The only requests are plain GETs of public pages.
 */
import "server-only";
import type { Client, InStatement } from "@libsql/client";
import { contentHash, newId } from "@/lib/ai-audit/hash";
import { assembleBrief, isBrief, type PreCallBrief } from "@/lib/ai-audit/brief";
import { readSite, type SiteReadDeps } from "@/lib/ai-audit/site-fetch";
import { visibleText } from "@/lib/ai-audit/site-checks";
import { siteTarget } from "@/lib/ai-audit/site-url";
import { PROFILE_EDIT_STAGES, type AiAuditStage } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, int, readLead, requireTenant, text, type Actor } from "@/lib/ai-audit/store";

export const SOURCE_KINDS = ["site_page", "robots_txt", "sitemap", "http_check", "form_answers"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
/** How far a source can be trusted: our own measurement, or what the client told us. */
export const RELIABILITY = ["own_measurement", "client_stated"] as const;

/** A brief may be built until Gate 1. */
export const BRIEF_STAGES: readonly AiAuditStage[] = PROFILE_EDIT_STAGES;
/** Built by itself, once, at these stages. */
export const AUTO_BRIEF_STAGES: readonly AiAuditStage[] = ["pre_call_research", "call_scheduled"];
/** Two builds closer together than this are one press too many. */
export const BRIEF_MIN_GAP_MS = 60_000;
/** The tick's own tries: it waits this long after one before the next, and stops after this many (the button still works). */
export const BRIEF_RETRY_MS = 30 * 60_000;
export const BRIEF_MAX_TICK_ATTEMPTS = 3;
/** The event the tick writes before each build it starts: durable, so a build that throws, or a run killed mid-build, still counts as a try. */
export const BRIEF_ATTEMPT_EVENT = "brief_attempt";

export type StoredBrief = {
  id: string;
  version_no: number;
  status: "ready" | "partial";
  site_url: string | null;
  content: PreCallBrief;
  content_sha256: string;
  created_by: string | null;
  created_at: string;
};

export function defaultSiteDeps(): SiteReadDeps {
  return { fetch: (url, init) => fetch(url, init), clock: () => Date.now() };
}

/** True when bravo__241's two tables exist. Only the brief needs them. */
export async function briefTablesInstalled(db: Client): Promise<boolean> {
  const rs = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_audit_briefs', 'ai_audit_sources')", args: [] });
  return rs.rows.length === 2;
}

/** The client's answers on the AI-audit form, newest submission first; null when there are none. */
export async function formAnswers(db: Client, tenantId: string, leadId: string): Promise<{ answers: Record<string, unknown>; at: string | null } | null> {
  const rs = await db.execute({
    sql: "SELECT metadata, created_at FROM lead_interactions WHERE tenant_id = ? AND lead_id = ? AND agent_source = 'ai_audit_funnel' ORDER BY created_at DESC LIMIT 1",
    args: [requireTenant(tenantId), leadId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  try {
    const meta = JSON.parse(String(row.metadata ?? "{}")) as { answers?: unknown };
    if (!meta.answers || typeof meta.answers !== "object" || Array.isArray(meta.answers)) return null;
    return { answers: meta.answers as Record<string, unknown>, at: text(row.created_at) };
  } catch {
    return null;
  }
}

function mapBrief(r: Record<string, unknown>): StoredBrief | null {
  let content: unknown = null;
  try {
    content = JSON.parse(String(r.content));
  } catch {
    content = null;
  }
  if (!isBrief(content)) return null;
  return {
    id: String(r.id),
    version_no: int(r.version_no, 1),
    status: String(r.status) === "partial" ? "partial" : "ready",
    site_url: text(r.site_url),
    content,
    content_sha256: String(r.content_sha256),
    created_by: text(r.created_by),
    created_at: String(r.created_at),
  };
}

export async function latestBrief(db: Client, tenantId: string, engagementId: string): Promise<StoredBrief | null> {
  const rs = await db.execute({
    sql: "SELECT id, version_no, status, site_url, content, content_sha256, created_by, created_at FROM ai_audit_briefs WHERE tenant_id = ? AND engagement_id = ? ORDER BY version_no DESC LIMIT 1",
    args: [requireTenant(tenantId), engagementId],
  });
  return rs.rows[0] ? mapBrief(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

/** The latest brief, for the pages: null before the first build, and null (said in the log) while bravo__241 is not applied. */
export async function briefForPage(db: Client, tenantId: string, engagementId: string): Promise<StoredBrief | null> {
  if (!(await briefTablesInstalled(db))) {
    console.error("[ai-audit.briefs] the brief tables are missing: apply database/turso/bravo__241_ai_audit_briefs.sql");
    return null;
  }
  return latestBrief(db, tenantId, engagementId);
}

export type BuildBriefResult = { ok: true; brief: StoredBrief; created: boolean } | { ok: false; error: "not_found" | "stage_closed" | "too_soon" | "not_installed" };

/** Build a new version of the engagement's brief: read the site, read the form, put it together, store it. */
export async function buildBrief(
  db: Client,
  input: { tenantId: string; engagementId: string; actor: Actor; now: Date; deps: SiteReadDeps },
): Promise<BuildBriefResult> {
  const t = requireTenant(input.tenantId);
  if (!(await briefTablesInstalled(db))) return { ok: false, error: "not_installed" };
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (!BRIEF_STAGES.includes(engagement.stage)) return { ok: false, error: "stage_closed" };
  // This build's version number is fixed here, before the site is read: a build
  // that started from the same brief at the same time collides on it below.
  const prior = (await db.execute({ sql: "SELECT version_no, created_at FROM ai_audit_briefs WHERE tenant_id = ? AND engagement_id = ? ORDER BY version_no DESC LIMIT 1", args: [t, engagement.id] })).rows[0];
  if (prior && input.now.getTime() - Date.parse(String(prior.created_at)) < BRIEF_MIN_GAP_MS) return { ok: false, error: "too_soon" };
  const versionNo = int(prior?.version_no) + 1;

  const lead = await readLead(db, t, engagement.lead_id);
  const target = siteTarget(lead?.website ?? null);
  const report = target.kind === "site" ? await readSite(target, input.deps) : null;
  const form = lead ? await formAnswers(db, t, lead.id) : null;
  const at = input.now.toISOString();
  const pagesRead = report?.pages.filter((p) => p.kind === "site_page" && !p.error && p.status !== null && p.status >= 200 && p.status < 300).length ?? 0;
  const content = assembleBrief({
    builtAt: at,
    business: { name: engagement.business_name || lead?.businessName || "this business", type: engagement.business_type },
    form,
    site: { target, start: report?.start, checks: report?.checks ?? [], pagesRead, notes: report?.notes ?? [], unread: report?.unread ?? null },
  });
  // Partial: something about the site is a gap (nothing read, a request that failed, a check not known).
  const status: StoredBrief["status"] = report && (report.unread !== null || report.notes.length > 0 || report.checks.some((c) => c.status === "unknown")) ? "partial" : "ready";
  const sha = contentHash(content);
  const briefId = newId();

  const sources: InStatement[] = [];
  for (const p of report?.pages ?? []) {
    sources.push({
      sql: `INSERT INTO ai_audit_sources (id, tenant_id, engagement_id, brief_id, kind, url, final_url, http_status, retrieved_at, content_sha256, bytes, excerpt, reliability, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'own_measurement', ?, ?)`,
      args: [
        newId(), t, engagement.id, briefId, p.kind, p.url, p.finalUrl, p.status, at,
        p.html !== null ? contentHash(p.html) : null, p.bytes,
        p.title ?? (p.html !== null ? visibleText(p.html).slice(0, 200) || null : null),
        JSON.stringify({ ms: p.ms, error: p.error }), at,
      ],
    });
  }
  if (form) {
    sources.push({
      sql: `INSERT INTO ai_audit_sources (id, tenant_id, engagement_id, brief_id, kind, url, final_url, http_status, retrieved_at, content_sha256, bytes, excerpt, reliability, meta_json, created_at)
            VALUES (?, ?, ?, ?, 'form_answers', NULL, NULL, NULL, ?, ?, NULL, NULL, 'client_stated', ?, ?)`,
      args: [newId(), t, engagement.id, briefId, form.at ?? at, contentHash(form.answers), JSON.stringify({ fields: Object.keys(form.answers).slice(0, 40) }), at],
    });
  }

  try {
    await db.batch(
      [
        {
          sql: "INSERT INTO ai_audit_briefs (id, tenant_id, engagement_id, version_no, status, site_url, content, content_sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [briefId, t, engagement.id, versionNo, status, content.site.url, JSON.stringify(content), sha, input.actor.id, at],
        },
        ...sources,
        eventStatement({ tenantId: t, engagementId: engagement.id, event: "brief_built", actor: input.actor, at, refType: "brief", refId: briefId, meta: { version_no: versionNo, status, pages_read: pagesRead, facts: content.facts.length, hypotheses: content.hypotheses.length } }),
      ],
      "write",
    );
  } catch (err) {
    // Two builds at once (a double press, or the tick and a press) started from
    // the same brief: the other stored this version first, and its brief is the answer.
    if (!(err instanceof Error && /UNIQUE constraint failed: ai_audit_briefs\./.test(err.message))) throw err;
    const winner = await latestBrief(db, t, engagement.id);
    if (!winner) throw new Error("ai-audit.briefs: another build stored this version, and it cannot be read back");
    return { ok: true, brief: winner, created: false };
  }
  const stored = await latestBrief(db, t, engagement.id);
  if (!stored) throw new Error("ai-audit.briefs: stored a brief but cannot read it back");
  return { ok: true, brief: stored, created: true };
}

/**
 * Engagements at Pre-call research or Meeting booked that have no
 * brief yet, leaving out any the tick tried in the last BRIEF_RETRY_MS, or has
 * tried BRIEF_MAX_TICK_ATTEMPTS times already. One that keeps failing waits
 * its turn instead of holding up the others.
 */
export async function dueBriefs(db: Client, tenantId: string, limit = 2, now = new Date()): Promise<string[]> {
  const t = requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT e.id FROM ai_audit_engagements e
          WHERE e.tenant_id = ? AND e.stage IN (${AUTO_BRIEF_STAGES.map(() => "?").join(", ")})
            AND NOT EXISTS (SELECT 1 FROM ai_audit_briefs b WHERE b.tenant_id = e.tenant_id AND b.engagement_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM ai_audit_events a WHERE a.tenant_id = e.tenant_id AND a.engagement_id = e.id AND a.event = ? AND a.created_at > ?)
            AND (SELECT COUNT(*) FROM ai_audit_events a WHERE a.tenant_id = e.tenant_id AND a.engagement_id = e.id AND a.event = ?) < ?
          ORDER BY e.updated_at LIMIT ?`,
    args: [t, ...AUTO_BRIEF_STAGES, BRIEF_ATTEMPT_EVENT, new Date(now.getTime() - BRIEF_RETRY_MS).toISOString(), BRIEF_ATTEMPT_EVENT, BRIEF_MAX_TICK_ATTEMPTS, limit],
  });
  return rs.rows.map((r) => String(r.id));
}
