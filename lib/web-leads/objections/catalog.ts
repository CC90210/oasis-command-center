/**
 * Reads the approved objection library.
 *
 * TENANT PINNING IS THE AUTHORIZATION BOUNDARY, same as lib/web-leads/outcome.ts
 * and lib/web-leads/audit.ts: libSQL has no row-level security, so every query
 * here pins WEBDEV_TENANT_ID explicitly.
 *
 * FAIL CLOSED. A read that errors THROWS. It never returns [], because an empty
 * array is indistinguishable from "this tenant has no objections yet" and the
 * console would render a calm empty state over a broken database.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
import {
  isObjectionFamily,
  isObjectionPosture,
  isWebsitePremise,
  type CatalogObjection,
  type ObjectionAnswer,
} from "./types";

export class CatalogReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogReadError";
  }
}

type ObjectionRow = {
  id: string; slug: string; says: string; meaning: string; prevent: string;
  family: string; source: string | null; dimension: string | null; status: string;
  website_premise?: string | null;
};

type ResponseRow = {
  id: string; objection_id: string; label: string; body: string;
  posture: string; is_default: number | boolean; status: string;
};

const OBJECTION_COLUMNS =
  "id, slug, says, meaning, prevent, family, source, dimension, status, website_premise";
const RESPONSE_COLUMNS = "id, objection_id, label, body, posture, is_default, status";

/**
 * PURE, and exported for tests. Everything that decides what a rep is allowed
 * to see lives here rather than in the query, so the rules survive a refactor
 * of the query builder.
 *
 * libSQL returns integers for booleans, so is_default is compared loosely on
 * purpose. A `=== true` here silently produces objections with no default.
 */
export function assembleCatalog(objections: ObjectionRow[], responses: ResponseRow[]): CatalogObjection[] {
  const byObjection = new Map<string, ObjectionAnswer[]>();

  for (const r of responses) {
    if (r.status !== "approved") continue;
    if (!isObjectionPosture(r.posture)) continue;
    const list = byObjection.get(r.objection_id) || [];
    list.push({
      id: r.id,
      label: r.label,
      body: r.body,
      posture: r.posture,
      isDefault: Number(r.is_default) === 1,
    });
    byObjection.set(r.objection_id, list);
  }

  const out: CatalogObjection[] = [];

  for (const o of objections) {
    if (o.status !== "approved") continue;
    if (!isObjectionFamily(o.family)) continue;

    const answers = byObjection.get(o.id) || [];
    // No approved answer means no card. A question with no line under it is
    // worse than an absent card: a rep opens it mid-sentence expecting to read.
    if (answers.length === 0) continue;

    // Deterministic order, and exactly one default even if a bad write made two.
    answers.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    for (let i = 1; i < answers.length; i += 1) answers[i].isDefault = false;

    out.push({
      id: o.id,
      slug: o.slug,
      says: o.says,
      meaning: o.meaning,
      prevent: o.prevent,
      family: o.family,
      source: o.source,
      dimension: o.dimension,
      // UNLIKE family and posture, an unrecognised premise does NOT drop the
      // row: family and posture decide whether a card can be RENDERED at all,
      // where the premise only nudges its rank. Denying a rep a whole
      // objection because someone typed a bad enum would be a worse failure
      // than ranking it on family base alone, so a value outside
      // WEBSITE_PREMISES degrades to null (premise-neutral), the same place an
      // unclassified row lands.
      websitePremise: isWebsitePremise(o.website_premise) ? o.website_premise : null,
      answers,
    });
  }

  return out;
}

export async function fetchApprovedCatalog(): Promise<CatalogObjection[]> {
  const db = getServiceSupabase();

  const objectionsRes = await db
    .from("objection_catalog")
    .select(OBJECTION_COLUMNS)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("status", "approved");
  if (objectionsRes.error) throw new CatalogReadError(`objection_catalog_read_failed: ${objectionsRes.error.message}`);

  const objections = (objectionsRes.data || []) as ObjectionRow[];
  if (objections.length === 0) return [];

  const responsesRes = await db
    .from("objection_response")
    .select(RESPONSE_COLUMNS)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("status", "approved")
    .in("objection_id", objections.map((o) => o.id));
  if (responsesRes.error) throw new CatalogReadError(`objection_response_read_failed: ${responsesRes.error.message}`);

  return assembleCatalog(objections, (responsesRes.data || []) as ResponseRow[]);
}

/**
 * Tenant-wide event counts, used only to break ranking ties. A failure here is
 * NOT fatal: the ranker's situational rules stand on their own, so a broken
 * rollup degrades the order slightly rather than denying a rep the console.
 * That is the one place in this module where swallowing is correct, and it is
 * loud in the log so it cannot rot silently.
 */
export async function fetchObjectionFrequency(): Promise<Record<string, number>> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("objection_event")
    .select("objection_id")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .limit(5000);

  if (error) {
    console.error("[objections.frequency] rollup unavailable, ranking on situational rules only", {
      error: error.message,
    });
    return {};
  }

  const counts: Record<string, number> = {};
  for (const row of (data || []) as { objection_id: string }[]) {
    counts[row.objection_id] = (counts[row.objection_id] || 0) + 1;
  }
  return counts;
}
