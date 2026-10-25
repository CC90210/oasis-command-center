/**
 * lib/ai-audit/doc.ts — the audit document (ai_audit_doc/v1): its shape, its
 * validator and the evidence rules every version must pass.
 *
 * ONE DATA MODEL, TWO RENDERINGS. The client's private page and the PDF are
 * both drawn from this JSON (components/ai-audit/doc/*). Nothing on either is
 * typed anywhere else.
 *
 * SELF-CONTAINED. A version carries the findings, estimates and sources it
 * cites, as they were when it was written. Later research never changes a
 * delivered audit: a change is a new version.
 *
 * PRICES ARE NOT HERE. Section 8 (Custom Solution & Pricing Proposal) is drawn
 * from the proposal version (proposal.ts), whose lines come only from a
 * catalogue item CC confirmed or a price CC typed. Section 9 is the payment
 * button plus next_steps.
 *
 * THE EVIDENCE RULES (auditDocIssues), from CC's brief section 5:
 *   - a Verified fact names at least one source;
 *   - a Client-reported fact names where the client said it;
 *   - a Reasonable estimate shows its inputs, its assumptions and a range;
 *   - a Hypothesis carries no figure of its own and says how to test it;
 *   - every paragraph that states a figure cites the finding, estimate or
 *     source it comes from. A figure with no citation blocks submission.
 * When the data is not there, the document says so (gaps) instead of filling
 * it in.
 *
 * PURE: the editor runs the same checks live in the browser.
 */
import {
  BUSINESS_TYPES,
  EVIDENCE_LABELS,
  isOneOf,
  type BusinessType,
  type EvidenceLabel,
} from "@/lib/ai-audit/rules";

export const AUDIT_DOC_SCHEMA = "ai_audit_doc/v1" as const;

export const SECTION_TITLES = [
  "Executive Overview",
  "Current Business Assessment",
  "Key Findings & Supporting Metrics",
  "Inefficiencies & Missed Opportunities",
  "AI & Automation Opportunities",
  "Prioritized Implementation Roadmap",
  "Estimated Business Impact",
  "Custom Solution & Pricing Proposal",
  "Secure Payment & Next Steps",
] as const;

export const SOURCE_KINDS = ["website", "measurement", "client", "publication", "listing", "other"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const IMPACT_LEVELS = ["high", "medium", "low"] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export type DocParagraph = { text: string; cites: string[] };

export type DocSource = {
  id: string;
  kind: SourceKind;
  title: string;
  publisher?: string;
  url?: string;
  retrieved_at?: string;
  published_at?: string;
  note?: string;
};

export type DocMetric = { value: number; unit: string; display?: string };

export type DocFinding = {
  id: string;
  title: string;
  statement: string;
  label: EvidenceLabel;
  metric?: DocMetric;
  source_ids: string[];
  /** A hypothesis says how it could be checked. */
  how_to_test?: string;
};

export type DocEstimateInput = {
  name: string;
  value: number;
  unit?: string;
  label: EvidenceLabel;
  /** A source id, or a short note ("assumption, editable"). */
  basis?: string;
};

export type DocEstimate = {
  id: string;
  title: string;
  /** Plain-words formula, e.g. "hours per week x weeks x share automated". */
  formula: string;
  low: number;
  high: number;
  unit: string;
  period?: string;
  inputs: DocEstimateInput[];
  assumptions: string[];
};

export type DocSystem = { name: string; role: string; note?: string; label: EvidenceLabel; cites: string[] };

export type DocInefficiency = {
  title: string;
  why_it_matters: DocParagraph;
  consequence: DocParagraph;
  finding_ids: string[];
};

export type DocOpportunity = {
  id: string;
  title: string;
  what_it_does: string;
  problem: string;
  how_it_works: string;
  integrations: string[];
  expected_improvement: DocParagraph;
  finding_ids: string[];
  estimate_ids: string[];
  workflow?: { before: string[]; after: string[] };
};

export type DocRoadmapItem = {
  opportunity_id: string;
  impact: ImpactLevel;
  effort: ImpactLevel;
  dependencies: string[];
  urgency: string;
};

export type AuditDoc = {
  schema: typeof AUDIT_DOC_SCHEMA;
  business: { name: string; type: BusinessType; location?: string; website?: string };
  prepared_for: { name: string };
  prepared_on: string;
  sections: {
    executive_overview: { paragraphs: DocParagraph[] };
    current_assessment: { paragraphs: DocParagraph[]; systems: DocSystem[] };
    key_findings: { intro?: DocParagraph; finding_ids: string[] };
    inefficiencies: { items: DocInefficiency[] };
    opportunities: { items: DocOpportunity[] };
    roadmap: { now: DocRoadmapItem[]; next: DocRoadmapItem[]; later: DocRoadmapItem[] };
    impact: { intro?: DocParagraph; estimate_ids: string[]; limitations: string[] };
    next_steps: { steps: string[] };
  };
  findings: DocFinding[];
  estimates: DocEstimate[];
  sources: DocSource[];
  gaps: Array<{ topic: string; why: string }>;
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DOC_LIMITS = {
  maxBytes: 200_000,
  text: 2_000,
  short: 200,
  paragraphs: 20,
  findings: 40,
  estimates: 20,
  sources: 60,
  opportunities: 12,
  roadmapItems: 12,
  listItems: 20,
  gaps: 30,
  systems: 30,
  inefficiencies: 15,
} as const;

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

export type DocIssue = { severity: "block" | "warn"; path: string; message: string };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function emptyAuditDoc(input: {
  businessName: string;
  businessType?: BusinessType;
  contactName?: string;
  website?: string;
  location?: string;
  today: string;
}): AuditDoc {
  return {
    schema: AUDIT_DOC_SCHEMA,
    business: {
      name: input.businessName,
      type: input.businessType ?? "other",
      ...(input.location ? { location: input.location } : {}),
      ...(input.website ? { website: input.website } : {}),
    },
    prepared_for: { name: input.contactName ?? "" },
    prepared_on: input.today.slice(0, 10),
    sections: {
      executive_overview: { paragraphs: [] },
      current_assessment: { paragraphs: [], systems: [] },
      key_findings: { finding_ids: [] },
      inefficiencies: { items: [] },
      opportunities: { items: [] },
      roadmap: { now: [], next: [], later: [] },
      impact: { estimate_ids: [], limitations: [] },
      next_steps: { steps: [] },
    },
    findings: [],
    estimates: [],
    sources: [],
    gaps: [],
  };
}

// ---------------------------------------------------------------------------
// Structural validation: shape, types and sizes. Never trusts the browser.
// ---------------------------------------------------------------------------

type V<T> = { ok: true; value: T } | { ok: false; path: string; message: string };

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, path: string, max: number, required = true): V<string> {
  if (v === undefined || v === null || v === "") {
    return required ? { ok: false, path, message: "is required" } : { ok: true, value: "" };
  }
  if (typeof v !== "string") return { ok: false, path, message: "must be text" };
  const s = v.replace(/\r\n/g, "\n").trim();
  if (required && !s) return { ok: false, path, message: "is required" };
  if (s.length > max) return { ok: false, path, message: `is longer than ${max} characters` };
  return { ok: true, value: s };
}

function num(v: unknown, path: string): V<number> {
  if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, path, message: "must be a number" };
  if (Math.abs(v) > 1e12) return { ok: false, path, message: "is out of range" };
  return { ok: true, value: v };
}

function ids(v: unknown, path: string, max: number = DOC_LIMITS.listItems): V<string[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, path, message: "must be a list" };
  if (v.length > max) return { ok: false, path, message: `has more than ${max} entries` };
  const out: string[] = [];
  for (const [i, x] of v.entries()) {
    if (typeof x !== "string" || !ID_RE.test(x)) return { ok: false, path: `${path}[${i}]`, message: "is not a valid id" };
    if (!out.includes(x)) out.push(x);
  }
  return { ok: true, value: out };
}

function strings(v: unknown, path: string, maxItems: number = DOC_LIMITS.listItems, maxLen: number = DOC_LIMITS.short): V<string[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, path, message: "must be a list" };
  if (v.length > maxItems) return { ok: false, path, message: `has more than ${maxItems} entries` };
  const out: string[] = [];
  for (const [i, x] of v.entries()) {
    const s = str(x, `${path}[${i}]`, maxLen);
    if (!s.ok) return s;
    out.push(s.value);
  }
  return { ok: true, value: out };
}

function paragraph(v: unknown, path: string, required = true): V<DocParagraph | undefined> {
  if (v === undefined || v === null) {
    return required ? { ok: false, path, message: "is required" } : { ok: true, value: undefined };
  }
  if (!obj(v)) return { ok: false, path, message: "must be a paragraph" };
  const text = str(v.text, `${path}.text`, DOC_LIMITS.text, required);
  if (!text.ok) return text;
  if (!required && !text.value) return { ok: true, value: undefined };
  const cites = ids(v.cites, `${path}.cites`);
  if (!cites.ok) return cites;
  return { ok: true, value: { text: text.value, cites: cites.value } };
}

function paragraphs(v: unknown, path: string): V<DocParagraph[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, path, message: "must be a list" };
  if (v.length > DOC_LIMITS.paragraphs) return { ok: false, path, message: `has more than ${DOC_LIMITS.paragraphs} paragraphs` };
  const out: DocParagraph[] = [];
  for (const [i, x] of v.entries()) {
    const p = paragraph(x, `${path}[${i}]`);
    if (!p.ok) return p;
    if (p.value) out.push(p.value);
  }
  return { ok: true, value: out };
}

function label(v: unknown, path: string): V<EvidenceLabel> {
  return isOneOf(EVIDENCE_LABELS, v) ? { ok: true, value: v } : { ok: false, path, message: "must be one of the four labels" };
}

function level(v: unknown, path: string): V<"high" | "medium" | "low"> {
  return isOneOf(["high", "medium", "low"] as const, v) ? { ok: true, value: v } : { ok: false, path, message: "must be high, medium or low" };
}

function list<T>(v: unknown, path: string, max: number, each: (x: unknown, p: string) => V<T>): V<T[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, path, message: "must be a list" };
  if (v.length > max) return { ok: false, path, message: `has more than ${max} entries` };
  const out: T[] = [];
  for (const [i, x] of v.entries()) {
    const r = each(x, `${path}[${i}]`);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
}

function idOf(v: unknown, path: string): V<string> {
  return typeof v === "string" && ID_RE.test(v) ? { ok: true, value: v } : { ok: false, path, message: "is not a valid id" };
}

function source(x: unknown, p: string): V<DocSource> {
  if (!obj(x)) return { ok: false, path: p, message: "must be a source" };
  const id = idOf(x.id, `${p}.id`);
  if (!id.ok) return id;
  if (!isOneOf(SOURCE_KINDS, x.kind)) return { ok: false, path: `${p}.kind`, message: "is not a known source kind" };
  const title = str(x.title, `${p}.title`, DOC_LIMITS.short);
  if (!title.ok) return title;
  const publisher = str(x.publisher, `${p}.publisher`, DOC_LIMITS.short, false);
  if (!publisher.ok) return publisher;
  const url = str(x.url, `${p}.url`, 2_000, false);
  if (!url.ok) return url;
  if (url.value && !/^https?:\/\/[^\s]+$/i.test(url.value)) return { ok: false, path: `${p}.url`, message: "must be a web address" };
  const retrieved = str(x.retrieved_at, `${p}.retrieved_at`, 40, false);
  if (!retrieved.ok) return retrieved;
  if (retrieved.value && !DATE_RE.test(retrieved.value)) return { ok: false, path: `${p}.retrieved_at`, message: "must be a date" };
  const published = str(x.published_at, `${p}.published_at`, 40, false);
  if (!published.ok) return published;
  if (published.value && !DATE_RE.test(published.value)) return { ok: false, path: `${p}.published_at`, message: "must be a date" };
  const note = str(x.note, `${p}.note`, DOC_LIMITS.short, false);
  if (!note.ok) return note;
  return {
    ok: true,
    value: {
      id: id.value,
      kind: x.kind,
      title: title.value,
      ...(publisher.value ? { publisher: publisher.value } : {}),
      ...(url.value ? { url: url.value } : {}),
      ...(retrieved.value ? { retrieved_at: retrieved.value } : {}),
      ...(published.value ? { published_at: published.value } : {}),
      ...(note.value ? { note: note.value } : {}),
    },
  };
}

function finding(x: unknown, p: string): V<DocFinding> {
  if (!obj(x)) return { ok: false, path: p, message: "must be a finding" };
  const id = idOf(x.id, `${p}.id`);
  if (!id.ok) return id;
  const title = str(x.title, `${p}.title`, DOC_LIMITS.short);
  if (!title.ok) return title;
  const statement = str(x.statement, `${p}.statement`, DOC_LIMITS.text);
  if (!statement.ok) return statement;
  const l = label(x.label, `${p}.label`);
  if (!l.ok) return l;
  let metric: DocMetric | undefined;
  if (x.metric !== undefined && x.metric !== null) {
    if (!obj(x.metric)) return { ok: false, path: `${p}.metric`, message: "must be a figure" };
    const value = num(x.metric.value, `${p}.metric.value`);
    if (!value.ok) return value;
    const unit = str(x.metric.unit, `${p}.metric.unit`, 40);
    if (!unit.ok) return unit;
    const display = str(x.metric.display, `${p}.metric.display`, 60, false);
    if (!display.ok) return display;
    metric = { value: value.value, unit: unit.value, ...(display.value ? { display: display.value } : {}) };
  }
  const src = ids(x.source_ids, `${p}.source_ids`);
  if (!src.ok) return src;
  const test = str(x.how_to_test, `${p}.how_to_test`, DOC_LIMITS.text, false);
  if (!test.ok) return test;
  return {
    ok: true,
    value: {
      id: id.value,
      title: title.value,
      statement: statement.value,
      label: l.value,
      ...(metric ? { metric } : {}),
      source_ids: src.value,
      ...(test.value ? { how_to_test: test.value } : {}),
    },
  };
}

function estimate(x: unknown, p: string): V<DocEstimate> {
  if (!obj(x)) return { ok: false, path: p, message: "must be an estimate" };
  const id = idOf(x.id, `${p}.id`);
  if (!id.ok) return id;
  const title = str(x.title, `${p}.title`, DOC_LIMITS.short);
  if (!title.ok) return title;
  const formula = str(x.formula, `${p}.formula`, DOC_LIMITS.short);
  if (!formula.ok) return formula;
  const low = num(x.low, `${p}.low`);
  if (!low.ok) return low;
  const high = num(x.high, `${p}.high`);
  if (!high.ok) return high;
  const unit = str(x.unit, `${p}.unit`, 40);
  if (!unit.ok) return unit;
  const period = str(x.period, `${p}.period`, 40, false);
  if (!period.ok) return period;
  const inputs = list(x.inputs, `${p}.inputs`, 12, (y, q): V<DocEstimateInput> => {
    if (!obj(y)) return { ok: false, path: q, message: "must be an input" };
    const name = str(y.name, `${q}.name`, DOC_LIMITS.short);
    if (!name.ok) return name;
    const value = num(y.value, `${q}.value`);
    if (!value.ok) return value;
    const u = str(y.unit, `${q}.unit`, 40, false);
    if (!u.ok) return u;
    const l = label(y.label, `${q}.label`);
    if (!l.ok) return l;
    const basis = str(y.basis, `${q}.basis`, DOC_LIMITS.short, false);
    if (!basis.ok) return basis;
    return { ok: true, value: { name: name.value, value: value.value, ...(u.value ? { unit: u.value } : {}), label: l.value, ...(basis.value ? { basis: basis.value } : {}) } };
  });
  if (!inputs.ok) return inputs;
  const assumptions = strings(x.assumptions, `${p}.assumptions`, 12, DOC_LIMITS.text);
  if (!assumptions.ok) return assumptions;
  return {
    ok: true,
    value: {
      id: id.value,
      title: title.value,
      formula: formula.value,
      low: low.value,
      high: high.value,
      unit: unit.value,
      ...(period.value ? { period: period.value } : {}),
      inputs: inputs.value,
      assumptions: assumptions.value,
    },
  };
}

function roadmapItem(x: unknown, p: string): V<DocRoadmapItem> {
  if (!obj(x)) return { ok: false, path: p, message: "must be a roadmap item" };
  const op = idOf(x.opportunity_id, `${p}.opportunity_id`);
  if (!op.ok) return op;
  const impact = level(x.impact, `${p}.impact`);
  if (!impact.ok) return impact;
  const effort = level(x.effort, `${p}.effort`);
  if (!effort.ok) return effort;
  const deps = strings(x.dependencies, `${p}.dependencies`, 8);
  if (!deps.ok) return deps;
  const urgency = str(x.urgency, `${p}.urgency`, DOC_LIMITS.short, false);
  if (!urgency.ok) return urgency;
  return { ok: true, value: { opportunity_id: op.value, impact: impact.value, effort: effort.value, dependencies: deps.value, urgency: urgency.value } };
}

/** Parse and normalise a document the browser sent. Refuses on the first structural fault. */
export function validateAuditDoc(raw: unknown): { ok: true; doc: AuditDoc } | { ok: false; path: string; message: string } {
  if (!obj(raw)) return { ok: false, path: "", message: "is not an audit document" };
  if (raw.schema !== AUDIT_DOC_SCHEMA) return { ok: false, path: "schema", message: `must be ${AUDIT_DOC_SCHEMA}` };
  try {
    if (JSON.stringify(raw).length > DOC_LIMITS.maxBytes) return { ok: false, path: "", message: "is too large" };
  } catch {
    return { ok: false, path: "", message: "is not valid JSON" };
  }
  const b = raw.business;
  if (!obj(b)) return { ok: false, path: "business", message: "is required" };
  const bname = str(b.name, "business.name", DOC_LIMITS.short);
  if (!bname.ok) return bname;
  if (!isOneOf(BUSINESS_TYPES, b.type)) return { ok: false, path: "business.type", message: "is not a known business type" };
  const loc = str(b.location, "business.location", DOC_LIMITS.short, false);
  if (!loc.ok) return loc;
  const site = str(b.website, "business.website", 500, false);
  if (!site.ok) return site;
  if (site.value && !/^https?:\/\/[^\s]+$/i.test(site.value)) return { ok: false, path: "business.website", message: "must be a web address" };
  const pf = obj(raw.prepared_for) ? raw.prepared_for : {};
  const pfName = str(pf.name, "prepared_for.name", DOC_LIMITS.short, false);
  if (!pfName.ok) return pfName;
  const on = str(raw.prepared_on, "prepared_on", 10);
  if (!on.ok) return on;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on.value)) return { ok: false, path: "prepared_on", message: "must be a date" };

  const s = obj(raw.sections) ? raw.sections : {};
  const sec = (k: string): Record<string, unknown> => (obj(s[k]) ? (s[k] as Record<string, unknown>) : {});

  const exec = paragraphs(sec("executive_overview").paragraphs, "sections.executive_overview.paragraphs");
  if (!exec.ok) return exec;
  const ca = sec("current_assessment");
  const caParas = paragraphs(ca.paragraphs, "sections.current_assessment.paragraphs");
  if (!caParas.ok) return caParas;
  const systems = list(ca.systems, "sections.current_assessment.systems", DOC_LIMITS.systems, (x, p): V<DocSystem> => {
    if (!obj(x)) return { ok: false, path: p, message: "must be a system" };
    const name = str(x.name, `${p}.name`, DOC_LIMITS.short);
    if (!name.ok) return name;
    const role = str(x.role, `${p}.role`, DOC_LIMITS.short);
    if (!role.ok) return role;
    const note = str(x.note, `${p}.note`, DOC_LIMITS.text, false);
    if (!note.ok) return note;
    const l = label(x.label, `${p}.label`);
    if (!l.ok) return l;
    const cites = ids(x.cites, `${p}.cites`);
    if (!cites.ok) return cites;
    return { ok: true, value: { name: name.value, role: role.value, ...(note.value ? { note: note.value } : {}), label: l.value, cites: cites.value } };
  });
  if (!systems.ok) return systems;

  const kf = sec("key_findings");
  const kfIntro = paragraph(kf.intro, "sections.key_findings.intro", false);
  if (!kfIntro.ok) return kfIntro;
  const kfIds = ids(kf.finding_ids, "sections.key_findings.finding_ids", DOC_LIMITS.findings);
  if (!kfIds.ok) return kfIds;

  const inefficiencies = list(sec("inefficiencies").items, "sections.inefficiencies.items", DOC_LIMITS.inefficiencies, (x, p): V<DocInefficiency> => {
    if (!obj(x)) return { ok: false, path: p, message: "must be an item" };
    const title = str(x.title, `${p}.title`, DOC_LIMITS.short);
    if (!title.ok) return title;
    const why = paragraph(x.why_it_matters, `${p}.why_it_matters`);
    if (!why.ok) return why;
    const cons = paragraph(x.consequence, `${p}.consequence`);
    if (!cons.ok) return cons;
    const f = ids(x.finding_ids, `${p}.finding_ids`);
    if (!f.ok) return f;
    return { ok: true, value: { title: title.value, why_it_matters: why.value!, consequence: cons.value!, finding_ids: f.value } };
  });
  if (!inefficiencies.ok) return inefficiencies;

  const opportunities = list(sec("opportunities").items, "sections.opportunities.items", DOC_LIMITS.opportunities, (x, p): V<DocOpportunity> => {
    if (!obj(x)) return { ok: false, path: p, message: "must be an opportunity" };
    const id = idOf(x.id, `${p}.id`);
    if (!id.ok) return id;
    const title = str(x.title, `${p}.title`, DOC_LIMITS.short);
    if (!title.ok) return title;
    const what = str(x.what_it_does, `${p}.what_it_does`, DOC_LIMITS.text);
    if (!what.ok) return what;
    const problem = str(x.problem, `${p}.problem`, DOC_LIMITS.text);
    if (!problem.ok) return problem;
    const how = str(x.how_it_works, `${p}.how_it_works`, DOC_LIMITS.text);
    if (!how.ok) return how;
    const integrations = strings(x.integrations, `${p}.integrations`, 12);
    if (!integrations.ok) return integrations;
    const improvement = paragraph(x.expected_improvement, `${p}.expected_improvement`);
    if (!improvement.ok) return improvement;
    const f = ids(x.finding_ids, `${p}.finding_ids`);
    if (!f.ok) return f;
    const e = ids(x.estimate_ids, `${p}.estimate_ids`);
    if (!e.ok) return e;
    let workflow: DocOpportunity["workflow"];
    if (x.workflow !== undefined && x.workflow !== null) {
      if (!obj(x.workflow)) return { ok: false, path: `${p}.workflow`, message: "must be before and after steps" };
      const before = strings(x.workflow.before, `${p}.workflow.before`, 8);
      if (!before.ok) return before;
      const after = strings(x.workflow.after, `${p}.workflow.after`, 8);
      if (!after.ok) return after;
      if (before.value.length || after.value.length) workflow = { before: before.value, after: after.value };
    }
    return {
      ok: true,
      value: {
        id: id.value,
        title: title.value,
        what_it_does: what.value,
        problem: problem.value,
        how_it_works: how.value,
        integrations: integrations.value,
        expected_improvement: improvement.value!,
        finding_ids: f.value,
        estimate_ids: e.value,
        ...(workflow ? { workflow } : {}),
      },
    };
  });
  if (!opportunities.ok) return opportunities;

  const rm = sec("roadmap");
  const now = list(rm.now, "sections.roadmap.now", DOC_LIMITS.roadmapItems, roadmapItem);
  if (!now.ok) return now;
  const next = list(rm.next, "sections.roadmap.next", DOC_LIMITS.roadmapItems, roadmapItem);
  if (!next.ok) return next;
  const later = list(rm.later, "sections.roadmap.later", DOC_LIMITS.roadmapItems, roadmapItem);
  if (!later.ok) return later;

  const im = sec("impact");
  const imIntro = paragraph(im.intro, "sections.impact.intro", false);
  if (!imIntro.ok) return imIntro;
  const imIds = ids(im.estimate_ids, "sections.impact.estimate_ids", DOC_LIMITS.estimates);
  if (!imIds.ok) return imIds;
  const limitations = strings(im.limitations, "sections.impact.limitations", 12, DOC_LIMITS.text);
  if (!limitations.ok) return limitations;

  const steps = strings(sec("next_steps").steps, "sections.next_steps.steps", 10, DOC_LIMITS.text);
  if (!steps.ok) return steps;

  const findings = list(raw.findings, "findings", DOC_LIMITS.findings, finding);
  if (!findings.ok) return findings;
  const estimates = list(raw.estimates, "estimates", DOC_LIMITS.estimates, estimate);
  if (!estimates.ok) return estimates;
  const sources = list(raw.sources, "sources", DOC_LIMITS.sources, source);
  if (!sources.ok) return sources;
  const gaps = list(raw.gaps, "gaps", DOC_LIMITS.gaps, (x, p): V<{ topic: string; why: string }> => {
    if (!obj(x)) return { ok: false, path: p, message: "must be a gap" };
    const topic = str(x.topic, `${p}.topic`, DOC_LIMITS.short);
    if (!topic.ok) return topic;
    const why = str(x.why, `${p}.why`, DOC_LIMITS.text);
    if (!why.ok) return why;
    return { ok: true, value: { topic: topic.value, why: why.value } };
  });
  if (!gaps.ok) return gaps;

  const all = [...findings.value.map((f) => f.id), ...estimates.value.map((e) => e.id), ...sources.value.map((x) => x.id), ...opportunities.value.map((o) => o.id)];
  const dup = all.find((id, i) => all.indexOf(id) !== i);
  if (dup) return { ok: false, path: "", message: `the id "${dup}" is used twice` };

  return {
    ok: true,
    doc: {
      schema: AUDIT_DOC_SCHEMA,
      business: {
        name: bname.value,
        type: b.type,
        ...(loc.value ? { location: loc.value } : {}),
        ...(site.value ? { website: site.value } : {}),
      },
      prepared_for: { name: pfName.value },
      prepared_on: on.value,
      sections: {
        executive_overview: { paragraphs: exec.value },
        current_assessment: { paragraphs: caParas.value, systems: systems.value },
        key_findings: { ...(kfIntro.value ? { intro: kfIntro.value } : {}), finding_ids: kfIds.value },
        inefficiencies: { items: inefficiencies.value },
        opportunities: { items: opportunities.value },
        roadmap: { now: now.value, next: next.value, later: later.value },
        impact: { ...(imIntro.value ? { intro: imIntro.value } : {}), estimate_ids: imIds.value, limitations: limitations.value },
        next_steps: { steps: steps.value },
      },
      findings: findings.value,
      estimates: estimates.value,
      sources: sources.value,
      gaps: gaps.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence rules (the brief's labels and "never invent a figure")
// ---------------------------------------------------------------------------

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
/** A year said as a year: "in 2025", "since 2019", "October 2024", "FY 2026". */
const YEAR_IN_CONTEXT = new RegExp(`\\b(?:in|since|from|by|until|till|through|before|after|during|of|year|fiscal|fy|${MONTHS})\\s+(?:19|20)\\d{2}\\b`, "gi");
/** Any digit in any script, and the vulgar fractions. */
const FIGURE_CHAR = /[\p{Nd}\u00BC-\u00BE\u2150-\u215E]/u;

/**
 * True when the text states a figure: any digit in any script, or a fraction
 * like "\u00BD", except a year said as a year ("in 2025"). A bare "2000" is a
 * figure: "$2000" and "2000 hours" are claims (review of PR #732). Spelled-out
 * quantities are left to the phase-4 claim linter (lib/offer-pages/claims.ts);
 * this check is the one a person can see live.
 */
export function statesFigure(text: string): boolean {
  return FIGURE_CHAR.test(text.replace(YEAR_IN_CONTEXT, ""));
}

/** Every rule the document breaks. "block" stops submission; "warn" is shown only. */
export function auditDocIssues(doc: AuditDoc): DocIssue[] {
  const issues: DocIssue[] = [];
  const findingIds = new Set(doc.findings.map((f) => f.id));
  const estimateIds = new Set(doc.estimates.map((e) => e.id));
  const sourceIds = new Set(doc.sources.map((s) => s.id));
  const opportunityIds = new Set(doc.sections.opportunities.items.map((o) => o.id));
  const sourceById = new Map(doc.sources.map((s) => [s.id, s]));
  const anyCite = (id: string) => findingIds.has(id) || estimateIds.has(id) || sourceIds.has(id);

  const checkParagraph = (p: DocParagraph | undefined, path: string) => {
    if (!p) return;
    for (const c of p.cites) {
      if (!anyCite(c)) issues.push({ severity: "block", path, message: `cites "${c}", which is not a finding, estimate or source in this audit` });
    }
    if (statesFigure(p.text) && p.cites.length === 0) {
      issues.push({ severity: "block", path, message: "states a figure without citing where it comes from" });
    }
  };

  // Text the page shows that has no way to cite: a figure there is a figure nobody can check.
  const uncited = (text: string | undefined, path: string, where = "Move it into a cited paragraph or finding, or remove it") => {
    if (text && statesFigure(text)) issues.push({ severity: "block", path, message: `states a figure in a part of the audit that cannot cite one. ${where}` });
  };

  doc.sections.executive_overview.paragraphs.forEach((p, i) => checkParagraph(p, `Executive Overview, paragraph ${i + 1}`));
  doc.sections.current_assessment.paragraphs.forEach((p, i) => checkParagraph(p, `Current Business Assessment, paragraph ${i + 1}`));
  checkParagraph(doc.sections.key_findings.intro, "Key Findings, introduction");
  doc.sections.inefficiencies.items.forEach((it, i) => {
    uncited(it.title, `Inefficiency ${i + 1}, title`);
    checkParagraph(it.why_it_matters, `Inefficiency ${i + 1}, why it matters`);
    checkParagraph(it.consequence, `Inefficiency ${i + 1}, consequence`);
    for (const f of it.finding_ids) if (!findingIds.has(f)) issues.push({ severity: "block", path: `Inefficiency ${i + 1}`, message: `names finding "${f}", which does not exist` });
  });
  doc.sections.opportunities.items.forEach((o, i) => {
    const where = `Opportunity ${i + 1} (${o.title})`;
    checkParagraph(o.expected_improvement, `${where}, expected improvement`);
    for (const t of [o.title, o.what_it_does, o.problem, o.how_it_works]) {
      if (statesFigure(t)) issues.push({ severity: "block", path: where, message: "states a figure outside its cited 'expected improvement'" });
    }
    for (const step of [...(o.workflow?.before ?? []), ...(o.workflow?.after ?? [])]) uncited(step, `${where}, workflow`);
    for (const f of o.finding_ids) if (!findingIds.has(f)) issues.push({ severity: "block", path: where, message: `names finding "${f}", which does not exist` });
    for (const e of o.estimate_ids) if (!estimateIds.has(e)) issues.push({ severity: "block", path: where, message: `names estimate "${e}", which does not exist` });
  });
  checkParagraph(doc.sections.impact.intro, "Estimated Business Impact, introduction");
  doc.sections.impact.limitations.forEach((l, i) => uncited(l, `Estimated Business Impact, limitation ${i + 1}`, "A figure an estimate rests on belongs in that estimate's assumptions"));
  doc.sections.next_steps.steps.forEach((step, i) => uncited(step, `Secure Payment & Next Steps, step ${i + 1}`, "Prices and amounts appear only in the proposal"));
  doc.gaps.forEach((g, i) => {
    uncited(g.topic, `Information gap ${i + 1}`, "A gap names what is unknown, not a figure");
    uncited(g.why, `Information gap ${i + 1}`, "A gap names what is unknown, not a figure");
  });

  for (const sys of doc.sections.current_assessment.systems) {
    for (const c of sys.cites) if (!anyCite(c)) issues.push({ severity: "block", path: `System ${sys.name}`, message: `cites "${c}", which does not exist` });
    if ((statesFigure(sys.role) || statesFigure(sys.note ?? "")) && sys.cites.length === 0) {
      issues.push({ severity: "block", path: `System ${sys.name}`, message: "states a figure without citing where it comes from" });
    }
    if (sys.label === "verified" && sys.cites.length === 0) {
      issues.push({ severity: "block", path: `System ${sys.name}`, message: "is marked Verified but cites nothing" });
    }
  }

  for (const id of doc.sections.key_findings.finding_ids) {
    if (!findingIds.has(id)) issues.push({ severity: "block", path: "Key Findings", message: `lists finding "${id}", which does not exist` });
  }
  for (const id of doc.sections.impact.estimate_ids) {
    if (!estimateIds.has(id)) issues.push({ severity: "block", path: "Estimated Business Impact", message: `lists estimate "${id}", which does not exist` });
  }
  for (const [bucket, items] of Object.entries(doc.sections.roadmap)) {
    for (const r of items) {
      uncited(r.urgency, `Roadmap (${bucket}), urgency`);
      for (const d of r.dependencies) uncited(d, `Roadmap (${bucket}), dependency`);
      if (!opportunityIds.has(r.opportunity_id)) {
        issues.push({ severity: "block", path: `Roadmap (${bucket})`, message: `names opportunity "${r.opportunity_id}", which does not exist` });
      }
    }
  }

  for (const f of doc.findings) {
    const where = `Finding "${f.title}"`;
    for (const s of f.source_ids) if (!sourceIds.has(s)) issues.push({ severity: "block", path: where, message: `names source "${s}", which does not exist` });
    if (f.label === "verified" && f.source_ids.length === 0) {
      issues.push({ severity: "block", path: where, message: "is a Verified fact with no source" });
    }
    if (f.label === "client_reported" && !f.source_ids.some((s) => sourceById.get(s)?.kind === "client")) {
      issues.push({ severity: "block", path: where, message: "is Client-reported but does not name where the client said it (a source of kind 'client')" });
    }
    if (f.label === "hypothesis") {
      if (f.metric) issues.push({ severity: "block", path: where, message: "is a Hypothesis, so it cannot carry a figure of its own" });
      if (statesFigure(f.statement)) issues.push({ severity: "block", path: where, message: "is a Hypothesis but its statement contains a figure" });
      if (!f.how_to_test) issues.push({ severity: "block", path: where, message: "is a Hypothesis and must say how it could be tested" });
    }
    if (f.label === "estimate") {
      issues.push({ severity: "block", path: where, message: "uses the estimate label: estimates belong in Estimated Business Impact, with inputs and assumptions" });
    }
    if (f.label !== "hypothesis" && statesFigure(f.statement) && f.source_ids.length === 0) {
      issues.push({ severity: "block", path: where, message: "states a figure without a source" });
    }
    if (statesFigure(f.title) && (f.label === "hypothesis" || f.source_ids.length === 0)) {
      issues.push({ severity: "block", path: where, message: f.label === "hypothesis" ? "is a Hypothesis but its title contains a figure" : "has a figure in its title but no source" });
    }
  }

  for (const e of doc.estimates) {
    const where = `Estimate "${e.title}"`;
    if (e.low > e.high) issues.push({ severity: "block", path: where, message: "has a low end above its high end" });
    if (e.low < 0 || e.high < 0) issues.push({ severity: "warn", path: where, message: "has a negative end; check the sign" });
    if (e.inputs.length === 0) issues.push({ severity: "block", path: where, message: "shows no inputs" });
    if (e.assumptions.length === 0) issues.push({ severity: "block", path: where, message: "states no assumptions" });
    for (const input of e.inputs) {
      if (input.label === "verified" && !(input.basis && sourceIds.has(input.basis))) {
        issues.push({ severity: "block", path: `${where}, input "${input.name}"`, message: "is marked Verified but its basis is not a source in this audit" });
      }
    }
    if (e.low === e.high) issues.push({ severity: "warn", path: where, message: "is a single number; an estimate reads better as a range" });
  }

  for (const s of doc.sources) {
    if ((s.kind === "website" || s.kind === "publication" || s.kind === "listing") && !s.url) {
      issues.push({ severity: "block", path: `Source "${s.title}"`, message: "is a web source without its address" });
    }
    if (s.url && !s.retrieved_at) issues.push({ severity: "warn", path: `Source "${s.title}"`, message: "does not say when it was retrieved" });
  }

  if (doc.sections.executive_overview.paragraphs.length === 0) issues.push({ severity: "block", path: "Executive Overview", message: "is empty" });
  if (doc.sections.current_assessment.paragraphs.length === 0) issues.push({ severity: "block", path: "Current Business Assessment", message: "is empty" });
  if (doc.sections.key_findings.finding_ids.length === 0) issues.push({ severity: "block", path: "Key Findings", message: "lists no findings" });
  if (doc.sections.opportunities.items.length === 0) issues.push({ severity: "block", path: "AI & Automation Opportunities", message: "is empty" });
  if (doc.sections.roadmap.now.length + doc.sections.roadmap.next.length + doc.sections.roadmap.later.length === 0) {
    issues.push({ severity: "block", path: "Prioritized Implementation Roadmap", message: "is empty" });
  }
  if (doc.sections.impact.estimate_ids.length > 0 && doc.sections.impact.limitations.length === 0) {
    issues.push({ severity: "block", path: "Estimated Business Impact", message: "shows estimates without stating their limitations" });
  }
  if (doc.sections.next_steps.steps.length === 0) issues.push({ severity: "block", path: "Secure Payment & Next Steps", message: "lists no next steps" });
  if (!doc.prepared_for.name) issues.push({ severity: "warn", path: "Prepared for", message: "has no contact name" });
  return issues;
}

export function blockingIssues(doc: AuditDoc): DocIssue[] {
  return auditDocIssues(doc).filter((i) => i.severity === "block");
}
