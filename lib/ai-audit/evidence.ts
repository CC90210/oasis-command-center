/**
 * lib/ai-audit/evidence.ts — the four evidence labels, enforced in code.
 *
 * Research proposes findings; this decides which label each may carry, from
 * what is actually stored behind it (CC's brief, section 5):
 *   - Verified fact: our own measurement produced it (a site check, a PageSpeed
 *     run), or a stored snapshot of a public page states it (its figure is in
 *     the snapshot's text), or CC confirmed it with a note. A published
 *     benchmark counts only from a medium- or high-reliability source dated in
 *     the last three years.
 *   - Client-reported: the client said it (a transcript's lines, a form field,
 *     CC's call notes).
 *   - Reasonable estimate: only the impact calculator makes one
 *     (lib/ai-audit/impact.ts); a finding is never an estimate.
 *   - Hypothesis: carries no figure of its own, and says how to test it.
 * A finding that fails is downgraded (a Verified fact with no proof becomes a
 * hypothesis when it has no figure) or dropped (a figure nobody can stand
 * behind), never upgraded; each change is listed with its reason.
 *
 * PURE: no I/O.
 */
import type { DocFinding } from "@/lib/ai-audit/doc";
import { numbersIn } from "@/lib/ai-audit/extract";

/** A source as research stored it: what the evidence rules may rely on. */
export type EvidenceSource = {
  id: string;
  kind: "measurement" | "website" | "listing" | "publication" | "client" | "other";
  /** The stored text a page's figure must appear in (a snapshot's excerpt or visible text). */
  text?: string;
  reliability?: "high" | "medium" | "low" | "own_measurement" | "client_stated";
  published_at?: string | null;
  /** CC confirmed the fact behind it, with this note. */
  confirmed_note?: string | null;
};

export type EvidenceChange = { finding_id: string; action: "downgraded" | "dropped"; reason: string };

const BENCHMARK_MAX_AGE_MS = 3 * 365.25 * 86_400_000;

/** The figure appears in the text as written: never 4 because the page says 400. */
function figureIn(value: number, text: string): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
  return numbersIn(text).some((n) => near(value, n));
}

const STOP = new Set("the and for with our you your its are was were has have had from into that this they them their than then also very just more most such only".split(" "));
const wordsOf = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
/**
 * A page's claim stands on the stored text only when the text says it: every
 * figure in the claim is in the text, and most of its words are (a claim the
 * model wrote about a page is not what the page says).
 */
function textStates(statement: string, text: string): boolean {
  if (numbersIn(statement).some((n) => !figureIn(n, text))) return false;
  const words = wordsOf(statement);
  if (!words.length) return false;
  const have = new Set(wordsOf(text));
  return words.filter((w) => have.has(w)).length / words.length >= 0.7;
}

/** Why `source` proves `finding`, or null when it does not. */
function proves(finding: DocFinding, source: EvidenceSource, now: Date): boolean {
  if (source.confirmed_note && source.confirmed_note.trim()) return true;
  if (source.kind === "measurement") return source.reliability === "own_measurement" || source.reliability === undefined;
  if (source.kind === "website" || source.kind === "listing" || source.kind === "publication") {
    const text = source.text ?? "";
    if (!text) return false;
    if (source.kind === "publication") {
      if (source.reliability !== "high" && source.reliability !== "medium") return false;
      const at = source.published_at ? Date.parse(source.published_at) : NaN;
      if (!Number.isFinite(at) || now.getTime() - at > BENCHMARK_MAX_AGE_MS || at > now.getTime() + 86_400_000) return false;
    }
    if (finding.metric && !figureIn(finding.metric.value, text)) return false;
    return textStates(finding.statement, text);
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
  const downgrade = (f: DocFinding, reason: string) => {
    // Only a finding with no figure of its own can stand as a hypothesis.
    const digits = /\d/.test(f.statement);
    if (f.metric || digits) {
      changes.push({ finding_id: f.id, action: "dropped", reason: `${reason}, and a figure cannot stand as a hypothesis` });
      return;
    }
    changes.push({ finding_id: f.id, action: "downgraded", reason });
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
      else changes.push({ finding_id: f.id, action: "dropped", reason: "it does not say where the client said it" });
      continue;
    }
    if (f.label === "estimate") {
      changes.push({ finding_id: f.id, action: "dropped", reason: "only the impact calculator makes an estimate" });
      continue;
    }
    // A hypothesis: no figure, and how to test it.
    if (f.metric || /\d/.test(f.statement)) {
      changes.push({ finding_id: f.id, action: "dropped", reason: "a hypothesis carries no figure of its own" });
      continue;
    }
    out.push({ ...f, source_ids: cited.map((s) => s.id), how_to_test: f.how_to_test || "Check it with the client before it is used." });
  }
  return { findings: out, changes };
}
