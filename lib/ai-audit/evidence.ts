/**
 * lib/ai-audit/evidence.ts — the four evidence labels, enforced in code.
 *
 * Research proposes findings; this decides which label each may carry, from
 * what is actually stored behind it (CC's brief, section 5):
 *   - Verified fact: our own measurement produced it (a site check, a PageSpeed
 *     run), or a stored snapshot of a public page states it, or CC confirmed it
 *     with a note. A page states a claim only when ONE of its sentences holds
 *     every figure of the claim, most of its words, and the same yes or no
 *     ("not available" never proves "available"); the page must have answered
 *     2xx, and a listing must name the business it speaks for. A published
 *     benchmark counts only from a named public body or research firm (high or
 *     medium reliability, set by research.ts from the host, never by the model)
 *     dated in the last three years.
 *   - Client-reported: the client said it (a transcript's lines, a form field,
 *     CC's call notes).
 *   - Reasonable estimate: only the impact calculator makes one
 *     (lib/ai-audit/impact.ts); a finding is never an estimate.
 *   - Hypothesis: carries no figure of its own, in any form (digits, words, a
 *     share like "half of"), and says how to test it.
 * A finding that fails is downgraded (a Verified fact with no proof becomes a
 * hypothesis when it has no figure) or dropped (a figure nobody can stand
 * behind), never upgraded; each change is listed with its reason.
 *
 * PURE: no I/O.
 */
import { statesFigure, type DocFinding } from "@/lib/ai-audit/doc";
import { fractionsIn, numbersIn } from "@/lib/ai-audit/extract";

/** A source as research stored it: what the evidence rules may rely on. */
export type EvidenceSource = {
  id: string;
  kind: "measurement" | "website" | "listing" | "publication" | "client" | "other";
  /** The stored text a page's claim must appear in: the sentences that state its claims, and the page's start. */
  text?: string;
  reliability?: "high" | "medium" | "low" | "own_measurement" | "client_stated";
  published_at?: string | null;
  /** CC confirmed the fact behind it, with this note. */
  confirmed_note?: string | null;
  /** For a page we read: its HTTP status. Only a page that answered 2xx proves anything. */
  http_status?: number | null;
  /** For a listing of the business (not a competitor's): whether the page names the business. False proves nothing. */
  about_business?: boolean | null;
};

export type EvidenceChange = { finding_id: string; title: string; action: "downgraded" | "dropped"; reason: string };

const BENCHMARK_MAX_AGE_MS = 3 * 365.25 * 86_400_000;

/** The figure appears in the text as written: never 4 because the page says 400. */
function figureIn(value: number, text: string): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
  return numbersIn(text).some((n) => near(value, n));
}

/** "one" that counts nothing: "each one", "no one", "one of them". */
const NOT_A_COUNT = /\b(?:each|every|no|any|some|the|this|that|which)\s+one\b|\bone\s+(?:of|another|by one)\b/gi;

/**
 * True when the text states a figure in any form: digits in any script, number
 * words ("forty percent", "a million"), or a share ("half of", "two thirds").
 * A hypothesis may carry none (review of phase 3, F2).
 */
export function statesAnyFigure(text: string): boolean {
  const plain = text.normalize("NFKC").replace(NOT_A_COUNT, " ");
  return statesFigure(plain) || numbersIn(plain).length > 0 || fractionsIn(plain).length > 0;
}

const STOP = new Set("the and for with our you your its are was were has have had from into that this they them their than then also very just more most such only".split(" "));
const wordsOf = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

const CURLY = new RegExp(`[${String.fromCharCode(0x2018, 0x2019)}]`, "g");
const NEGATION = /\b(?:not|no|never|none|nothing|without|cannot|unable|unavailable)\b|n't\b/i;
const negated = (s: string) => NEGATION.test(s.replace(CURLY, "'"));
/** A digit in another script (Arabic-Indic and the like): a figure the check cannot read. */
const OTHER_DIGIT = /\p{Nd}/u;

/** The text's sentences, and a long run without stops (a page of headings and widgets) cut into windows of 40 words. */
function sentencesIn(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?])\s+|\s+\.\.\.\s+|\n+/)) {
    const s = part.trim();
    if (!s) continue;
    if (s.length <= 300) {
      out.push(s);
      continue;
    }
    const words = s.split(/\s+/);
    for (let i = 0; i < words.length; i += 20) {
      out.push(words.slice(i, i + 40).join(" "));
      if (i + 40 >= words.length) break;
    }
  }
  return out;
}

/**
 * The one sentence of `text` that states `statement`: every figure in it, at
 * least 70% of its words, and the same yes or no. Null when no single sentence
 * does, or when the statement writes a figure the check cannot read (review of
 * phase 3, F1: a claim's figures scattered over a page, a "not" dropped, or
 * digits in another script are never a match).
 */
export function sentenceStating(statement: string, text: string): string | null {
  const claim = statement.normalize("NFKC");
  if (OTHER_DIGIT.test(claim.replace(/[0-9]/g, ""))) return null;
  const figures = numbersIn(claim);
  const words = wordsOf(claim);
  if (!words.length) return null;
  const no = negated(claim);
  for (const sentence of sentencesIn(text.normalize("NFKC"))) {
    if (figures.some((n) => !figureIn(n, sentence))) continue;
    if (negated(sentence) !== no) continue;
    const have = new Set(wordsOf(sentence));
    if (words.filter((w) => have.has(w)).length / words.length >= 0.7) return sentence;
  }
  return null;
}

/** Words a business name shares with many others: never what tells it apart. */
const GENERIC_NAME_WORDS = new Set(["inc", "ltd", "llc", "corp", "corporation", "company", "group", "services", "service", "test"]);

/**
 * True when the page's text names the business: every telling word of a name
 * of one or two such words, or 70% of a longer one. A listing that does not
 * name the business speaks for no one (review of phase 3, F1).
 */
export function namesBusiness(text: string, name: string): boolean {
  const want = wordsOf(name).filter((w) => !GENERIC_NAME_WORDS.has(w));
  if (!want.length) return false;
  const have = new Set(wordsOf(text));
  const n = want.filter((w) => have.has(w)).length;
  return want.length <= 2 ? n === want.length : n / want.length >= 0.7;
}

/** Why `source` proves `finding`, or null when it does not. */
function proves(finding: DocFinding, source: EvidenceSource, now: Date): boolean {
  if (source.confirmed_note && source.confirmed_note.trim()) return true;
  if (source.kind === "measurement") return source.reliability === "own_measurement" || source.reliability === undefined;
  if (source.kind === "website" || source.kind === "listing" || source.kind === "publication") {
    const text = source.text ?? "";
    if (!text) return false;
    // A 404 or 500 page's figures are nobody's facts; a listing that never names the business is not its listing.
    if (typeof source.http_status !== "number" || source.http_status < 200 || source.http_status >= 300) return false;
    if (source.about_business === false) return false;
    if (source.kind === "publication") {
      if (source.reliability !== "high" && source.reliability !== "medium") return false;
      const at = source.published_at ? Date.parse(source.published_at) : NaN;
      if (!Number.isFinite(at) || now.getTime() - at > BENCHMARK_MAX_AGE_MS || at > now.getTime() + 86_400_000) return false;
    }
    // The figure a finding carries is one its own statement states, and the page states both.
    if (finding.metric && (!figureIn(finding.metric.value, finding.statement) || !figureIn(finding.metric.value, text))) return false;
    return sentenceStating(finding.statement, text) !== null;
  }
  return false;
}

/**
 * Each finding with the label its evidence allows, and what changed. Sources
 * a finding names that do not exist are ignored (never trusted).
 */
export function enforceEvidence(findings: readonly DocFinding[], sources: readonly EvidenceSource[], now: Date): { findings: DocFinding[]; changes: EvidenceChange[] } {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const out: DocFinding[] = [];
  const changes: EvidenceChange[] = [];
  const change = (f: DocFinding, action: EvidenceChange["action"], reason: string) => changes.push({ finding_id: f.id, title: f.title.slice(0, 200), action, reason });
  const downgrade = (f: DocFinding, reason: string) => {
    // Only a finding with no figure of its own can stand as a hypothesis.
    if (f.metric || statesAnyFigure(f.statement)) {
      change(f, "dropped", `${reason}, and a figure cannot stand as a hypothesis`);
      return;
    }
    change(f, "downgraded", reason);
    out.push({ ...f, label: "hypothesis", source_ids: f.source_ids.filter((id) => byId.has(id)), how_to_test: f.how_to_test || "Check it with the client before it is used." });
  };
  for (const f of findings) {
    const cited = f.source_ids.map((id) => byId.get(id)).filter((s): s is EvidenceSource => !!s);
    if (f.label === "verified") {
      if (cited.some((s) => proves(f, s, now))) out.push({ ...f, source_ids: cited.map((s) => s.id) });
      else downgrade(f, "no stored source proves it");
      continue;
    }
    if (f.label === "client_reported") {
      if (cited.some((s) => s.kind === "client")) out.push({ ...f, source_ids: cited.map((s) => s.id) });
      else change(f, "dropped", "it does not say where the client said it");
      continue;
    }
    if (f.label === "estimate") {
      change(f, "dropped", "only the impact calculator makes an estimate");
      continue;
    }
    // A hypothesis: no figure, and how to test it.
    if (f.metric || statesAnyFigure(f.statement)) {
      change(f, "dropped", "a hypothesis carries no figure of its own");
      continue;
    }
    out.push({ ...f, source_ids: cited.map((s) => s.id), how_to_test: f.how_to_test || "Check it with the client before it is used." });
  }
  return { findings: out, changes };
}
