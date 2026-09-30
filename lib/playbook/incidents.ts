/**
 * lib/playbook/incidents.ts - validation for a Law 25 s.3.8 register entry.
 * PURE: the route (app/api/playbook/incidents) and the page's form share it.
 *
 * Every field the register must hold is required except the ones that may be
 * genuinely unknown when the entry is made: how many people (null = not yet
 * known), whether the risk is serious (null = not yet assessed), and the
 * notification dates (null = not notified). Unknown is recorded as unknown,
 * never as zero or "no".
 */

import type { Incident, IncidentInput } from "./store";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The register form, filled to correct `entry`: its own values (the founder
 * changes what was wrong) and `corrects_id` set to its full id. The register
 * page shows each entry's short id and a Correct button that opens this; the
 * full id is what the route checks, so a founder never has to find or type it.
 * The values are the form's own strings, so they round-trip through
 * parseIncident unchanged.
 */
export function correctionDraft(entry: Incident): Record<string, string> {
  return {
    personal_info: entry.personal_info,
    circumstances: entry.circumstances,
    occurred_period: entry.occurred_period,
    aware_at: entry.aware_at,
    persons_count: entry.persons_count === null ? "" : String(entry.persons_count),
    serious_risk: entry.serious_risk === null ? "unknown" : entry.serious_risk === 1 ? "yes" : "no",
    risk_assessment: entry.risk_assessment,
    cai_notified_at: entry.cai_notified_at ?? "",
    persons_notified_at: entry.persons_notified_at ?? "",
    measures: entry.measures,
    corrects_id: entry.id,
  };
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

function optionalDate(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && DATE.test(v) ? v : undefined;
}

/** The entry, or the first field that is wrong. */
export function parseIncident(body: Record<string, unknown>): { ok: true; entry: IncidentInput } | { ok: false; field: string } {
  const personal_info = text(body.personal_info, 4000);
  if (!personal_info) return { ok: false, field: "personal_info" };
  const circumstances = text(body.circumstances, 8000);
  if (!circumstances) return { ok: false, field: "circumstances" };
  const occurred_period = text(body.occurred_period, 200);
  if (!occurred_period) return { ok: false, field: "occurred_period" };
  const aware_at = typeof body.aware_at === "string" && DATE.test(body.aware_at) ? body.aware_at : null;
  if (!aware_at) return { ok: false, field: "aware_at" };
  const risk_assessment = text(body.risk_assessment, 8000);
  if (!risk_assessment) return { ok: false, field: "risk_assessment" };
  const measures = text(body.measures, 8000);
  if (!measures) return { ok: false, field: "measures" };
  let persons_count: number | null = null;
  if (body.persons_count !== undefined && body.persons_count !== null && body.persons_count !== "") {
    const n = Number(body.persons_count);
    if (!Number.isInteger(n) || n < 0) return { ok: false, field: "persons_count" };
    persons_count = n;
  }
  let serious_risk: number | null = null;
  if (body.serious_risk === true || body.serious_risk === "yes") serious_risk = 1;
  else if (body.serious_risk === false || body.serious_risk === "no") serious_risk = 0;
  else if (body.serious_risk !== undefined && body.serious_risk !== null && body.serious_risk !== "" && body.serious_risk !== "unknown") {
    return { ok: false, field: "serious_risk" };
  }
  const cai = optionalDate(body.cai_notified_at);
  if (cai === undefined) return { ok: false, field: "cai_notified_at" };
  const persons = optionalDate(body.persons_notified_at);
  if (persons === undefined) return { ok: false, field: "persons_notified_at" };
  let corrects_id: string | null = null;
  if (body.corrects_id !== undefined && body.corrects_id !== null && body.corrects_id !== "") {
    corrects_id = text(body.corrects_id, 64);
    if (!corrects_id) return { ok: false, field: "corrects_id" };
  }
  return {
    ok: true,
    entry: {
      personal_info,
      circumstances,
      occurred_period,
      aware_at,
      persons_count,
      risk_assessment,
      serious_risk,
      cai_notified_at: cai,
      persons_notified_at: persons,
      measures,
      corrects_id,
    },
  };
}
