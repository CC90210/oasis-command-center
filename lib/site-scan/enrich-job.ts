/**
 * lib/site-scan/enrich-job.ts — the runner side of a scan: what the site_scan_enrich job hands
 * the VPS at claim time, and how its answer is checked and stored.
 *
 * The job row holds the scan id only. The input is built here, from the row, so the queue never
 * carries page text. The answer is validated field by field with hard caps: it is data from a
 * machine we run, but a runner can be wrong, and nothing it says reaches a visitor unchecked.
 */
import type { Client, InStatement } from "@libsql/client";
import { enrichStatement, getScan, saveEnrich } from "@/lib/site-scan/store";
import { ENRICH_SCHEMA, NARRATIVE_SCHEMA, type ScanEnrich, type ScanNarrative } from "@/lib/site-scan/types";

export const ENRICH_INPUT_TEXT_MAX = 6_000;
const STR_MAX = 600;
const EMBEDDING_MAX = 1_024;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export type EnrichJobInput = {
  scan_id: string;
  domain: string;
  url: string;
  /** The tenant whose leadgen_businesses rows the runner may read for competitors and prospects. */
  leadgen_tenant_id: string;
  facts: Record<string, unknown>;
  score: Record<string, unknown> | null;
  text_excerpt: string;
};

export async function enrichJobInput(
  db: Client,
  job: { tenantId: string; input: Record<string, unknown> },
): Promise<{ ok: true; input: EnrichJobInput } | { ok: false; code: "gone" | "bad_input" }> {
  const scanId = typeof job.input.scan_id === "string" ? job.input.scan_id : "";
  if (!scanId) return { ok: false, code: "bad_input" };
  const scan = await getScan(db, job.tenantId, scanId);
  if (!scan || !scan.facts || scan.status === "failed") return { ok: false, code: "gone" };
  const { signals, ...rest } = scan.facts;
  const text = signals?.text_excerpt ?? "";
  return {
    ok: true,
    input: {
      scan_id: scan.id,
      // The host only: a shared-builder scan's key carries the business's folder (scanKeyOf), and
      // the runner looks this name up in DNS and in the directory.
      domain: scan.domain.split("/")[0],
      url: scan.url,
      leadgen_tenant_id: job.tenantId,
      facts: { ...rest, signals: signals ? { ...signals, text_excerpt: undefined } : null },
      score: scan.score as unknown as Record<string, unknown> | null,
      text_excerpt: text.slice(0, ENRICH_INPUT_TEXT_MAX),
    },
  };
}

function str(v: unknown, max = STR_MAX): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function strList(v: unknown, max: number, each = 120): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = str(x, each);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}

function tri(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function domain(v: unknown): string | null {
  const s = str(v, 253);
  if (!s) return null;
  const d = s.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return /^[a-z0-9.-]{3,253}$/.test(d) && d.includes(".") ? d : null;
}

export function parseEnrich(raw: unknown): ScanEnrich | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.schema !== ENRICH_SCHEMA) return null;
  const engine = (o.engine ?? {}) as Record<string, unknown>;
  const cat = o.category && typeof o.category === "object" ? (o.category as Record<string, unknown>) : null;
  const category = cat && str(cat.key, 64) && str(cat.label, 120) ? { key: str(cat.key, 64)!, label: str(cat.label, 120)!, confidence: num(cat.confidence, 0, 1) ?? 0 } : null;
  const segments: ScanEnrich["segments"] = [];
  for (const s of Array.isArray(o.segments) ? o.segments.slice(0, 6) : []) {
    const r = (s ?? {}) as Record<string, unknown>;
    const key = str(r.key, 64);
    const label = str(r.label, 120);
    const fit = num(r.fit, 0, 100);
    const why = str(r.why, 300);
    if (key && label && fit !== null && why) segments.push({ key, label, fit: Math.round(fit), why });
  }
  const competitors: ScanEnrich["competitors"] = [];
  for (const c of Array.isArray(o.competitors) ? o.competitors.slice(0, 8) : []) {
    const r = (c ?? {}) as Record<string, unknown>;
    const name = str(r.name, 120);
    if (name) competitors.push({ name, domain: domain(r.domain), locality: str(r.locality, 80) });
  }
  const prospects: ScanEnrich["prospects"] = [];
  for (const p of Array.isArray(o.prospects) ? o.prospects.slice(0, 8) : []) {
    const r = (p ?? {}) as Record<string, unknown>;
    const name = str(r.name, 120);
    const categoryLabel = str(r.category_label, 120);
    const why = str(r.why, 300);
    if (name && categoryLabel && why) prospects.push({ name, locality: str(r.locality, 80), region: str(r.region, 40), domain: domain(r.domain), category_label: categoryLabel, why });
  }
  const ea = o.email_auth && typeof o.email_auth === "object" ? (o.email_auth as Record<string, unknown>) : null;
  return {
    schema: ENRICH_SCHEMA,
    engine: { embedder: str(engine.embedder, 80) ?? "unknown", version: str(engine.version, 40) ?? "0" },
    category,
    keywords: strList(o.keywords, 20, 40),
    segments,
    competitors,
    prospects,
    email_auth: ea ? { mx: tri(ea.mx), spf: tri(ea.spf), dmarc: tri(ea.dmarc) } : null,
    notes: strList(o.notes, 10, 200),
  };
}

export function parseNarrative(raw: unknown): ScanNarrative | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.schema !== NARRATIVE_SCHEMA) return null;
  const whatYouSell = str(o.what_you_sell, 900);
  const whoBuys = str(o.who_buys, 900);
  const fixesIntro = str(o.fixes_intro, 900);
  if (!whatYouSell || !whoBuys || !fixesIntro) return null;
  const em = o.email && typeof o.email === "object" ? (o.email as Record<string, unknown>) : null;
  const subject = em ? str(em.subject, 160) : null;
  const body = em && typeof em.body === "string" ? em.body.replace(CONTROL_RE, "").trim().slice(0, 1_800) : null;
  return {
    schema: NARRATIVE_SCHEMA,
    source: o.source === "model" ? "model" : "template",
    what_you_sell: whatYouSell,
    who_buys: whoBuys,
    competitors_note: str(o.competitors_note, 600),
    fixes_intro: fixesIntro,
    email: subject && body ? { to: em ? str(em.to, 160) : null, subject, body } : null,
  };
}

export function parseEmbedding(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > EMBEDDING_MAX) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out.push(Math.round(v * 1e5) / 1e5);
  }
  return out;
}

export type EnrichReport = { enrich: ScanEnrich; narrative: ScanNarrative | null; embedding: number[] | null };

export function parseEnrichReport(b: Record<string, unknown>): { ok: true; value: EnrichReport } | { ok: false; field: string } {
  const enrich = parseEnrich(b.enrich);
  if (!enrich) return { ok: false, field: "enrich" };
  const narrative = b.narrative === undefined || b.narrative === null ? null : parseNarrative(b.narrative);
  if (b.narrative !== undefined && b.narrative !== null && !narrative) return { ok: false, field: "narrative" };
  const embedding = b.embedding === undefined || b.embedding === null ? null : parseEmbedding(b.embedding);
  if (b.embedding !== undefined && b.embedding !== null && !embedding) return { ok: false, field: "embedding" };
  return { ok: true, value: { enrich, narrative, embedding } };
}

/** Store a checked report on the scan it was for. False when the scan moved on (failed, deleted). */
/** The report's scan write, guarded by the runner's lease (store.enrichStatement); null when the job names no scan. */
export function enrichReportStatement(
  input: { tenantId: string; jobInput: Record<string, unknown>; report: EnrichReport; now: Date },
  lease: { jobId: string; runnerKey: string; leaseId: string },
): InStatement | null {
  const scanId = typeof input.jobInput.scan_id === "string" ? input.jobInput.scan_id : "";
  if (!scanId) return null;
  return enrichStatement({ tenantId: input.tenantId, id: scanId, enrich: input.report.enrich, narrative: input.report.narrative, embedding: input.report.embedding, now: input.now }, lease);
}

export async function applyEnrichReport(
  db: Client,
  input: { tenantId: string; jobInput: Record<string, unknown>; report: EnrichReport; now: Date },
): Promise<boolean> {
  const scanId = typeof input.jobInput.scan_id === "string" ? input.jobInput.scan_id : "";
  if (!scanId) return false;
  return saveEnrich(db, { tenantId: input.tenantId, id: scanId, enrich: input.report.enrich, narrative: input.report.narrative, embedding: input.report.embedding, now: input.now });
}
