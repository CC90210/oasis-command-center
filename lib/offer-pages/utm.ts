/**
 * lib/offer-pages/utm.ts - first-touch campaign attribution on a lead
 * (HANDOVER section 5.3 / build spec item 5): utm_source, utm_medium,
 * utm_campaign, kw (keyword) and cat (the funnel pillar, p1-p4) from the
 * offer page's query string, stamped once at submit.
 *
 * DELIBERATELY SEPARATE FROM lib/forms/lead-source.ts. That module's
 * LEAD_SOURCE_KEY ("lead_source") is the Text/Dial/Email origination channel
 * and already feeds pipelineBreakdown()'s "Lead sources" card — overloading
 * it with campaign data would corrupt both. These five keys live beside it on
 * the same lead, on their own namespace, and never touch LEAD_SOURCE_KEY.
 *
 * FIRST-TOUCH WINS, same rule as adoptLeadSource: once a lead carries a real
 * value for a key, a retry, a duplicate delivery, or the same visitor
 * returning through a different campaign link can never overwrite it. A key
 * that has never been set CAN be filled in later — an upgrade from "never
 * attributed", not a reassignment.
 *
 * ATOMIC WRITE (Codex review, PR #598, 2026-10-12 [P2]). stampUtmOnLead used
 * to read the lead's `data`, compute the patch in JS, and write the WHOLE
 * object back. Two submissions for the same lead overlapping could both read
 * the same unset field and race to write it (the later write wins, not the
 * first, which is backwards for "first touch"), and the full-object rewrite
 * could discard an unrelated field some OTHER write committed in between the
 * read and this write. The fix is ONE UPDATE statement per call, built from
 * `json_set` + `COALESCE(json_extract(...), ?)` per key — SQLite (and so
 * libSQL) evaluates the whole SET expression against the CURRENT row inside
 * the single statement, so "keep the existing value if there is one, else
 * use the new one" is enforced by the database itself, not by a read this
 * code did a moment ago. Every OTHER key in `data` this statement does not
 * name is untouched, unlike a full-object write.
 */
import type { Client } from "@libsql/client";

export const UTM_FIELDS =["utm_source", "utm_medium", "utm_campaign", "kw", "cat"] as const;
export type UtmField = (typeof UTM_FIELDS)[number];

/** The jsonb keys on tenant_records.data this module owns. */
export const UTM_KEYS: Record<UtmField, string> = {
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  kw: "kw",
  cat: "cat",
};
export const UTM_AT_KEY = "utm_captured_at";

/** The only values `cat` may carry (the four funnel pillars, HANDOVER section 4). */
const CAT_VALUES = new Set(["p1", "p2", "p3", "p4"]);

/** A raw query value this long or longer is a mangled link or an attack, not a campaign tag. */
const MAX_RAW_LENGTH = 128;

export type UtmInput = Partial<Record<UtmField, unknown>>;

/**
 * Normalize one untrusted field value. Total function: never throws. `cat`
 * is checked against its closed vocabulary (lowercased); every other field
 * is free text, trimmed and length-capped — a UTM campaign name is operator-
 * chosen text, not a fixed enum, so it is never validated against a list the
 * way lead_source's channel is.
 */
export function normalizeUtmField(field: UtmField, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_RAW_LENGTH) return null;
  if (field === "cat") {
    const lowered = trimmed.toLowerCase();
    return CAT_VALUES.has(lowered) ? lowered : null;
  }
  return trimmed;
}

/**
 * Builds the `json_set(data, ...)` expression (and its bound parameters)
 * that stamps exactly the fields this call has a valid value for, each
 * guarded by `COALESCE(json_extract(data, '<path>'), ?)` so the database
 * itself keeps an existing value over the new one. Pure and testable: null
 * when there is nothing valid to stamp at all, so the caller can skip the
 * UPDATE entirely. The JSON path literals are built from the fixed
 * UTM_KEYS/UTM_AT_KEY constants, never from caller input, so there is no
 * injection surface in interpolating them directly into the SQL text --
 * only the VALUES are placeholders.
 */
export function buildUtmSetExpression(utm: UtmInput, nowIso: string): { sql: string; args: string[] } | null {
  const clauses: string[] = [];
  const args: string[] = [];
  for (const field of UTM_FIELDS) {
    const value = normalizeUtmField(field, utm[field]);
    if (value === null) continue;
    const key = UTM_KEYS[field];
    clauses.push(`'$.${key}', COALESCE(json_extract(data, '$.${key}'), ?)`);
    args.push(value);
  }
  if (!clauses.length) return null;
  clauses.push(`'$.${UTM_AT_KEY}', COALESCE(json_extract(data, '$.${UTM_AT_KEY}'), ?)`);
  args.push(nowIso);
  return { sql: `json_set(data, ${clauses.join(", ")})`, args };
}

/**
 * Stamp first-touch UTM attribution on a lead in ONE atomic UPDATE -- see
 * the module doc comment for why this replaced a read-then-write. A no-op
 * (nothing valid to stamp, or a DB error) is silent and never throws --
 * this is best-effort attribution, not a gate on the submission it rides
 * alongside.
 */
export async function stampUtmOnLead(
  db: Client,
  input: { tenantId: string; leadId: string; utm: UtmInput; now: string },
): Promise<void> {
  const built = buildUtmSetExpression(input.utm, input.now);
  if (!built) return;
  try {
    await db.execute({
      sql: `UPDATE tenant_records SET data = ${built.sql} WHERE id = ? AND tenant_id = ? AND entity_type = 'lead'`,
      args: [...built.args, input.leadId, input.tenantId],
    });
  } catch (err) {
    console.error("[offer-pages.utm] stamp failed", {
      leadId: input.leadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
