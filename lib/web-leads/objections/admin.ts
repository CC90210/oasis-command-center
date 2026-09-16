/**
 * The authoring half of the objection engine: everything the `/objections`
 * surface needs to get an objection from "a rep heard this on a call" to "a
 * rep can read an approved answer off the card".
 *
 * WHY THIS IS SEPARATE FROM catalog.ts. That module is the READ path the
 * battle card uses on every open, and it reads approved rows only. This one
 * reads every status and writes. Keeping them apart means a bug in authoring
 * cannot widen what the console shows a rep mid-call, which is the one thing
 * in this engine that must not regress.
 *
 * WHAT THIS DOES NOT DO, stated rather than implied:
 *   - It never deletes. `objection_event` rows point at catalog and response
 *     ids, so a delete would orphan the history the scoreboard is built on.
 *     Retiring is the only removal, and it hides the row from the console
 *     immediately while leaving every past event readable.
 *   - It never auto-merges a duplicate. `findDuplicate` returns a candidate
 *     and a score for a HUMAN to act on. Silently folding one objection into
 *     another destroys the distinction a rep actually heard, and the two
 *     wordings often want different answers even when they score as similar.
 *   - It does not generate copy. Drafting answers with a model is a separate
 *     route and it writes drafts, never approved rows.
 */

import { randomUUID } from "node:crypto";

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import {
  isObjectionFamily,
  isObjectionPosture,
  isWebsitePremise,
  type ObjectionFamily,
  type ObjectionPosture,
  type WebsitePremise,
} from "@/lib/web-leads/objections/types";

export class ObjectionAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectionAdminError";
  }
}

/** Raised when a human must act. Distinct from a failure so a caller can tell
 *  "you typed something we will not accept" from "the database is down", and
 *  render the first without paging anyone about the second. */
export class ObjectionRejected extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ObjectionRejected";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Copy rules on the WRITE path.
//
// tests/objection-copy.test.ts pins the same rules over the SEED source, which
// is the only door that existed when it was written. This surface is a second
// door into the same table, and a guard that covers one of two doors is
// decorative. These run before any insert or update, so a sentence typed into
// the UI faces exactly what a seeded one faces.
// ---------------------------------------------------------------------------

/** Em dash and en dash. Both are the standing tell of generated text in
 *  customer-facing copy, and both render as a dash a rep stumbles over. */
const DASH = /[—–]/;
/** A double hyphen renders literally on the card rather than as a dash. */
const DOUBLE_HYPHEN = /--/;
/** A currency symbol, or a figure attached to a money word. A rep reading a
 *  number off a script is quoting a price nobody scoped to that business. */
const MONEY = /[$£€]|\b\d[\d,.]*\s*(?:dollars?|bucks|grand|cents?|k)\b/i;

/** The longest a single spoken answer may be. Not a style preference: past
 *  this a rep stops reading it and starts paraphrasing, and a paraphrased
 *  answer is not the one the scoreboard thinks was used. */
export const MAX_BODY_LENGTH = 1200;
/** The longest an objection itself may be. It is a sentence a customer said. */
export const MAX_SAYS_LENGTH = 400;

/**
 * Every copy rule violated by `text`, as human-readable sentences. Empty means
 * it passes. Returns ALL of them rather than the first, so somebody pasting a
 * batch fixes their wording once instead of discovering the rules one at a
 * time.
 */
export function copyViolations(text: string, field: string, maxLength: number): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    out.push(`${field} is empty.`);
    return out;
  }
  if (trimmed.length > maxLength) {
    out.push(`${field} is ${trimmed.length} characters, over the ${maxLength} limit.`);
  }
  if (DASH.test(trimmed)) out.push(`${field} contains an em or en dash. Use a comma, a period or a hyphen.`);
  if (DOUBLE_HYPHEN.test(trimmed)) out.push(`${field} contains a double hyphen, which renders literally on the card.`);
  if (MONEY.test(trimmed)) out.push(`${field} states a money figure. A spoken line must never quote an unscoped price.`);
  return out;
}

// ---------------------------------------------------------------------------
// Matching, for dedup.
// ---------------------------------------------------------------------------

/** Words carrying no signal for whether two objections are the same one. Kept
 *  deliberately short: an aggressive list collapses genuinely different
 *  objections onto each other, and a false duplicate is worse than a missed
 *  one because it suppresses something a rep really heard. */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "it", "its", "we", "our", "us", "i", "im", "ive", "you", "your",
  "to", "of", "in", "on", "at", "for", "and", "or", "but", "so", "that", "this", "with",
  "have", "has", "had", "do", "does", "did", "be", "am", "are", "was", "were", "been",
  "just", "really", "right", "now", "well", "look", "yeah", "ok", "okay", "um", "uh",
]);

/**
 * `says` reduced to the form two wordings of the same objection share:
 * lowercase, curly quotes folded to straight, punctuation dropped, whitespace
 * collapsed.
 *
 * Deliberately NOT stemmed and NOT stopword-stripped. This is the string an
 * EXACT-duplicate check compares, and exactness is the point: "we have no
 * budget" and "we have no budget." are the same objection typed twice, while
 * anything looser belongs in the scored path below where a human sees it.
 */
export function normaliseSays(says: string): string {
  return says
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The content words of an objection, for the similarity score. */
export function contentTokens(says: string): string[] {
  return normaliseSays(says)
    .split(" ")
    .map((t) => t.replace(/'/g, ""))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Jaccard overlap of content words, 0 to 1.
 *
 * Chosen over an edit distance on purpose: the same objection arrives with
 * wildly different lengths ("no budget" against "we have absolutely no budget
 * for anything like that this year"), which edit distance scores as far apart
 * and shared vocabulary scores as close. Two objections with no content words
 * in common score 0 rather than throwing, and two empties score 0 rather than
 * 1, because an empty candidate must never look like a perfect match.
 */
export function similarity(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared++;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** At or above this, a human is shown the existing row before they add a new
 *  one. Below it, nothing is said. Tuned to catch rewordings without flagging
 *  every objection that happens to mention a website. */
export const NEAR_DUPLICATE_SCORE = 0.6;

export type DuplicateVerdict =
  | { kind: "exact"; id: string; slug: string; says: string; status: string }
  | { kind: "near"; id: string; slug: string; says: string; status: string; score: number }
  | { kind: "none" };

/**
 * Whether `candidate` is already in `existing`.
 *
 * NEVER acts. An exact normalised match is reported as `exact` and the caller
 * refuses the write, because the identical sentence twice is a typo rather
 * than a decision. Anything at or above NEAR_DUPLICATE_SCORE is reported as
 * `near` and the caller SHOWS it: the human either accepts the existing row or
 * confirms the new one is genuinely different. Folding them automatically is
 * what makes a library quietly lose the objection a rep actually heard.
 */
export function findDuplicate(
  candidate: string,
  existing: { id: string; slug: string; says: string; status: string }[],
): DuplicateVerdict {
  const normalised = normaliseSays(candidate);
  if (normalised.length === 0) return { kind: "none" };

  for (const row of existing) {
    if (normaliseSays(row.says) === normalised) {
      return { kind: "exact", id: row.id, slug: row.slug, says: row.says, status: row.status };
    }
  }

  let best: { row: (typeof existing)[number]; score: number } | null = null;
  for (const row of existing) {
    const score = similarity(candidate, row.says);
    if (score >= NEAR_DUPLICATE_SCORE && (!best || score > best.score)) best = { row, score };
  }
  if (!best) return { kind: "none" };
  return {
    kind: "near",
    id: best.row.id,
    slug: best.row.slug,
    says: best.row.says,
    status: best.row.status,
    score: Number(best.score.toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Batch parsing.
// ---------------------------------------------------------------------------

/** Leading list marks a person pastes without meaning them as content. */
const LIST_MARK = /^\s*(?:[-*•‣◦]|\d{1,3}[.)])\s+/;

/**
 * A pasted block split into candidate objections, one per line.
 *
 * Line-based, not sentence-based, and that is a decision rather than a
 * shortcut: objections routinely contain a full stop ("It looks fine on my
 * phone. I checked."), so splitting on sentences would cut one objection into
 * two and quietly double the library. A person pasting a list already puts one
 * per line.
 *
 * Strips list marks and surrounding quotes, drops blanks and exact repeats
 * within the same paste, and preserves the order typed so the review list
 * matches what the person is looking at.
 */
export function parseBatch(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(LIST_MARK, "").trim();
    // Surrounding quotes, straight or curly, in matched pairs only: a line
    // that merely ends in a quotation mark keeps it.
    line = line.replace(/^["'“‘]+\s*/, "").replace(/\s*["'”’]+$/, "").trim();
    if (line.length === 0) continue;
    const key = normaliseSays(line);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * A stable slug for a new objection.
 *
 * Content words only, so "We have no budget for that right now" and a later
 * "we have no budget" do not produce two slugs that differ only by filler.
 * Capped at six words to stay readable in a URL and in the seed's own slug
 * list. Collisions are resolved by the caller against what is already stored,
 * never by trusting this to be unique on its own.
 */
export function slugify(says: string): string {
  const words = contentTokens(says).slice(0, 6);
  const base = words.join("-").replace(/[^a-z0-9-]/g, "");
  return base.length > 0 ? base : `objection-${Date.now().toString(36)}`;
}

/** `slug`, or `slug-2`, `slug-3`, ... until it is not in `taken`. */
export function uniqueSlug(slug: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  for (let n = 2; n < 1000; n++) {
    const next = `${slug}-${n}`;
    if (!used.has(next)) return next;
  }
  throw new ObjectionAdminError(`could not find a free slug for ${slug} after 999 attempts`);
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export type AdminResponse = {
  id: string;
  label: string;
  body: string;
  posture: ObjectionPosture;
  isDefault: boolean;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
};

export type AdminObjection = {
  id: string;
  slug: string;
  says: string;
  meaning: string;
  prevent: string;
  family: ObjectionFamily;
  websitePremise: WebsitePremise | null;
  status: string;
  origin: string;
  dimension: string | null;
  source: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  updatedAt: string | null;
  responses: AdminResponse[];
};

const CATALOG_COLUMNS =
  "id,slug,says,meaning,prevent,family,source,status,origin,dimension,website_premise,approved_by,approved_at,updated_at";
const RESPONSE_COLUMNS = "id,objection_id,label,body,posture,is_default,status,approved_by,approved_at";

type CatalogRow = {
  id: string; slug: string; says: string; meaning: string; prevent: string;
  family: string; source: string | null; status: string; origin: string;
  dimension: string | null; website_premise: string | null;
  approved_by: string | null; approved_at: string | null; updated_at: string | null;
};
type ResponseRow = {
  id: string; objection_id: string; label: string; body: string; posture: string;
  is_default: number | boolean; status: string; approved_by: string | null; approved_at: string | null;
};

/** libSQL returns booleans as 0/1 and a strict `=== true` silently never
 *  matches, which is recorded project doctrine. */
function truthy(v: number | boolean | null | undefined): boolean {
  return v === true || v === 1;
}

/**
 * Every objection in the tenant, in EVERY status, with its responses.
 *
 * Unlike `fetchApprovedCatalog`, a row whose family or posture is not a
 * recognised value is KEPT here rather than dropped. The console drops it
 * because a rep must never be shown a half-classified card mid-call; the
 * library is the one place a human can SEE that a row is broken and fix it,
 * and a library that hides its broken rows makes them unfixable.
 */
export async function fetchAdminCatalog(): Promise<AdminObjection[]> {
  const db = getServiceSupabase();

  const objectionsRes = await db
    .from("objection_catalog")
    .select(CATALOG_COLUMNS)
    .eq("tenant_id", WEBDEV_TENANT_ID);
  if (objectionsRes.error) {
    throw new ObjectionAdminError(`objection_catalog_read_failed: ${objectionsRes.error.message}`);
  }
  const rows = (objectionsRes.data || []) as CatalogRow[];
  if (rows.length === 0) return [];

  const responsesRes = await db
    .from("objection_response")
    .select(RESPONSE_COLUMNS)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .in("objection_id", rows.map((r) => r.id));
  if (responsesRes.error) {
    throw new ObjectionAdminError(`objection_response_read_failed: ${responsesRes.error.message}`);
  }

  const byObjection = new Map<string, AdminResponse[]>();
  for (const r of (responsesRes.data || []) as ResponseRow[]) {
    const list = byObjection.get(r.objection_id) ?? [];
    list.push({
      id: r.id,
      label: r.label,
      body: r.body,
      // Kept even when unrecognised, for the same reason the objection is:
      // the library must be able to show a broken row so a human can fix it.
      posture: (isObjectionPosture(r.posture) ? r.posture : r.posture) as ObjectionPosture,
      isDefault: truthy(r.is_default),
      status: r.status,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
    });
    byObjection.set(r.objection_id, list);
  }

  return rows
    .map((o) => ({
      id: o.id,
      slug: o.slug,
      says: o.says,
      meaning: o.meaning,
      prevent: o.prevent,
      family: (isObjectionFamily(o.family) ? o.family : o.family) as ObjectionFamily,
      websitePremise: isWebsitePremise(o.website_premise) ? o.website_premise : null,
      status: o.status,
      origin: o.origin,
      dimension: o.dimension,
      source: o.source,
      approvedBy: o.approved_by,
      approvedAt: o.approved_at,
      updatedAt: o.updated_at,
      responses: (byObjection.get(o.id) ?? []).sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.posture.localeCompare(b.posture);
      }),
    }))
    .sort((a, b) => a.says.localeCompare(b.says));
}

/** Just enough of every row to run a duplicate check against. */
export async function fetchMatchIndex(): Promise<{ id: string; slug: string; says: string; status: string }[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("objection_catalog")
    .select("id,slug,says,status")
    .eq("tenant_id", WEBDEV_TENANT_ID);
  if (error) throw new ObjectionAdminError(`objection_catalog_match_read_failed: ${error.message}`);
  return (data || []) as { id: string; slug: string; says: string; status: string }[];
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

export type DraftInput = {
  says: string;
  meaning: string;
  prevent: string;
  family: ObjectionFamily;
  websitePremise?: WebsitePremise | null;
  source?: string | null;
};

/**
 * Creates one DRAFT objection.
 *
 * Draft, always, whoever is calling. Nothing reaches a rep's screen without
 * passing the approval gate, and letting a create-with-approved shortcut exist
 * would make that gate optional for anyone who found the parameter.
 *
 * Refuses an exact duplicate outright and refuses copy that breaks the rules.
 * A NEAR duplicate does not refuse: the caller has already been given the
 * match and the human decided to proceed, and overriding that decision here
 * would make the library unable to hold two genuinely similar objections.
 */
export async function createDraftObjection(
  input: DraftInput,
  createdBy: string,
): Promise<{ id: string; slug: string }> {
  const says = input.says.trim();
  const violations = [
    ...copyViolations(says, "The objection", MAX_SAYS_LENGTH),
    ...copyViolations(input.meaning, "What it really means", MAX_BODY_LENGTH),
    ...copyViolations(input.prevent, "How to prevent it", MAX_BODY_LENGTH),
  ];
  if (violations.length > 0) {
    throw new ObjectionRejected("copy_rules", violations.join(" "));
  }
  if (!isObjectionFamily(input.family)) {
    throw new ObjectionRejected("family", `"${String(input.family)}" is not one of the six families.`);
  }

  const existing = await fetchMatchIndex();
  const verdict = findDuplicate(says, existing);
  if (verdict.kind === "exact") {
    throw new ObjectionRejected(
      "duplicate",
      `That objection is already in the library as "${verdict.slug}" (${verdict.status}).`,
    );
  }

  const slug = uniqueSlug(slugify(says), existing.map((e) => e.slug));
  const now = new Date().toISOString();
  const id = randomUUID();

  const db = getServiceSupabase();
  const { error } = await db.from("objection_catalog").insert({
    id,
    tenant_id: WEBDEV_TENANT_ID,
    slug,
    says,
    meaning: input.meaning.trim(),
    prevent: input.prevent.trim(),
    family: input.family,
    source: input.source?.trim() || null,
    website_premise: input.websitePremise ?? null,
    status: "draft",
    origin: "ingested",
    dimension: null,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  });
  if (error) throw new ObjectionAdminError(`objection_catalog_insert_failed: ${error.message}`);
  return { id, slug };
}

export type EditTargetStatus = { objectionStatus: string | null; responseStatus: string | null };

/**
 * The CURRENT status of the rows a PATCH is about to touch.
 *
 * The route cannot decide who may make an edit from the payload alone. A
 * payload that carries only `says` or `body` looks like a harmless wording
 * fix, and it IS one on a draft. On an already-approved row it rewrites a
 * sentence that is live on reps' screens right now, which is the same act as
 * approving one and belongs behind the same bar.
 *
 * A row that cannot be found reports null, and the caller treats null as
 * "approved" rather than "draft", so an unreadable or missing row demands the
 * higher permission instead of the lower one.
 */
export async function fetchEditTargetStatus(
  objectionId: string,
  responseId?: string,
): Promise<EditTargetStatus> {
  const db = getServiceSupabase();

  const objection = await db
    .from("objection_catalog")
    .select("status")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", objectionId)
    .maybeSingle();
  if (objection.error) {
    throw new ObjectionAdminError(`objection_catalog_status_read_failed: ${objection.error.message}`);
  }

  let responseStatus: string | null = null;
  if (responseId) {
    const response = await db
      .from("objection_response")
      .select("status")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("id", responseId)
      .eq("objection_id", objectionId)
      .maybeSingle();
    if (response.error) {
      throw new ObjectionAdminError(`objection_response_status_read_failed: ${response.error.message}`);
    }
    responseStatus = (response.data as { status?: string } | null)?.status ?? null;
  }

  return {
    objectionStatus: (objection.data as { status?: string } | null)?.status ?? null,
    responseStatus,
  };
}

export type ObjectionPatch = {
  says?: string;
  meaning?: string;
  prevent?: string;
  family?: ObjectionFamily;
  websitePremise?: WebsitePremise | null;
  status?: "draft" | "approved" | "retired";
};

/**
 * Edits, approves or retires one objection.
 *
 * `approver` is required for a status change to `approved` and is stamped onto
 * the row. The ROLE check belongs to the route, which is where the session
 * lives; this refuses to stamp an approval without a name so the two cannot
 * drift into a state where a row is approved by nobody.
 */
export async function updateObjection(
  id: string,
  patch: ObjectionPatch,
  approver: string | null,
  expectedStatus?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };

  if (patch.says !== undefined) {
    const v = copyViolations(patch.says, "The objection", MAX_SAYS_LENGTH);
    if (v.length) throw new ObjectionRejected("copy_rules", v.join(" "));
    update.says = patch.says.trim();
  }
  for (const [key, column, label] of [
    ["meaning", "meaning", "What it really means"],
    ["prevent", "prevent", "How to prevent it"],
  ] as const) {
    const value = patch[key];
    if (value !== undefined) {
      const v = copyViolations(value, label, MAX_BODY_LENGTH);
      if (v.length) throw new ObjectionRejected("copy_rules", v.join(" "));
      update[column] = value.trim();
    }
  }
  if (patch.family !== undefined) {
    if (!isObjectionFamily(patch.family)) {
      throw new ObjectionRejected("family", `"${String(patch.family)}" is not one of the six families.`);
    }
    update.family = patch.family;
  }
  if (patch.websitePremise !== undefined) {
    update.website_premise = patch.websitePremise ?? null;
  }
  if (patch.status !== undefined) {
    if (patch.status === "approved") {
      if (!approver) {
        throw new ObjectionRejected("approver", "An approval must record who approved it.");
      }
      update.approved_by = approver;
      update.approved_at = new Date().toISOString();
    }
    update.status = patch.status;
  }

  const db = getServiceSupabase();
  let write = db
    .from("objection_catalog")
    .update(update)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", id);
  // COMPARE AND SWAP on the status the CALLER WAS AUTHORIZED AGAINST.
  //
  // The route reads the stored status to decide whether this edit needs closer
  // rights. Between that read and this write, a closer can approve the row, and
  // an author's wording change would then land on copy that is now live, with
  // nobody having approved the new wording. Conditioning the write on the
  // status observed at authorization time means the row simply does not match
  // any more and the edit does not land.
  if (expectedStatus !== undefined && expectedStatus !== null) {
    write = write.eq("status", expectedStatus);
  }
  const { error } = await write;
  if (error) throw new ObjectionAdminError(`objection_catalog_update_failed: ${error.message}`);
  if (expectedStatus !== undefined && expectedStatus !== null) {
    await assertWriteLanded("objection_catalog", id, now);
  }
}

/**
 * Confirms a compare-and-swap actually wrote, and says so when it did not.
 *
 * A conditional update that matches nothing is not an error to this client: it
 * reports success having changed no rows, which is the silent-no-op shape this
 * estate has been bitten by before. Re-reading `updated_at` and comparing it to
 * the exact timestamp just written is what turns "matched nothing" into a
 * message a person can act on, rather than an edit that appears to save and
 * then is not there on reload.
 */
async function assertWriteLanded(table: string, id: string, writtenAt: string): Promise<void> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from(table)
    .select("updated_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ObjectionAdminError(`${table}_verify_failed: ${error.message}`);
  if ((data as { updated_at?: string } | null)?.updated_at !== writtenAt) {
    throw new ObjectionRejected(
      "changed_since_read",
      "Somebody changed this while you were editing, so nothing was saved. Reload and try again.",
    );
  }
}

export type ResponsePatch = {
  label?: string;
  body?: string;
  status?: "draft" | "approved" | "retired";
  makeDefault?: boolean;
};

/**
 * Edits, approves, retires or promotes one response.
 *
 * THE DEFAULT IS CLEAR-THEN-SET, never an upsert with a conflict target. The
 * uniqueness is enforced by a PARTIAL index, `(tenant_id, objection_id) WHERE
 * is_default = 1 AND status = 'approved'`, and project doctrine records that
 * an upsert against a partial unique index fails SILENTLY rather than loudly.
 * Clearing every sibling first means exactly one row comes back up and the
 * index is satisfied rather than dodged.
 *
 * A response cannot be made default unless it is approved, checked here rather
 * than left to the index: the index only covers approved rows, so a draft
 * marked default would slip past it and then become the live answer the moment
 * somebody approved it, without anyone choosing that.
 */
export async function updateResponse(
  responseId: string,
  objectionId: string,
  patch: ResponsePatch,
  approver: string | null,
  expectedStatus?: string | null,
): Promise<void> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };

  if (patch.label !== undefined) {
    const v = copyViolations(patch.label, "The label", 60);
    if (v.length) throw new ObjectionRejected("copy_rules", v.join(" "));
    update.label = patch.label.trim();
  }
  if (patch.body !== undefined) {
    const v = copyViolations(patch.body, "The answer", MAX_BODY_LENGTH);
    if (v.length) throw new ObjectionRejected("copy_rules", v.join(" "));
    update.body = patch.body.trim();
  }

  const becomingApproved = patch.status === "approved";
  if (patch.status !== undefined) {
    if (becomingApproved) {
      if (!approver) throw new ObjectionRejected("approver", "An approval must record who approved it.");
      update.approved_by = approver;
      update.approved_at = now;
    }
    update.status = patch.status;
    // Retiring the default would leave the objection with no default at all,
    // which renders a card whose first answer is arbitrary. Drop the flag and
    // let a human promote a replacement deliberately.
    if (patch.status === "retired") update.is_default = 0;
  }

  // THE RESPONSE MUST BELONG TO THIS OBJECTION, proven before anything is
  // written. `responseId` comes from the request body and `objectionId` from
  // the URL, so nothing but this check stops a caller pairing an id from one
  // objection with another objection's route. Unscoped, `makeDefault` cleared
  // every default under the URL's objection and then promoted a row parented
  // elsewhere: the URL objection is left with NO default, and the promoted
  // row's real parent can end up with two, which is a uniqueness failure on
  // the partial index. Reported as a rejection rather than a silent no-op,
  // because a mismatched pair is a caller bug and must be visible as one.
  const owner = await db
    .from("objection_response")
    .select("id,status")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", responseId)
    .eq("objection_id", objectionId)
    .maybeSingle();
  if (owner.error) {
    throw new ObjectionAdminError(`objection_response_read_failed: ${owner.error.message}`);
  }
  if (!owner.data) {
    throw new ObjectionRejected(
      "response_not_in_objection",
      "That answer does not belong to this objection.",
    );
  }

  if (patch.makeDefault) {
    const status = becomingApproved ? "approved" : (owner.data as { status?: string }).status;
    if (status !== "approved") {
      throw new ObjectionRejected(
        "default_not_approved",
        "Only an approved answer can be the default one a rep sees first.",
      );
    }
    // EVERY SIBLING, BUT NOT THIS ROW.
    //
    // Excluding the target is what keeps the write verifiable. When the clear
    // included it, the clear stamped `updated_at = now` onto the very row the
    // conditional update was about to touch; if that update then matched
    // nothing, because the status moved underneath us, `assertWriteLanded`
    // read the timestamp the CLEAR had written and reported success. The API
    // returned 200 having cleared every default and promoted nothing, leaving
    // the objection with no default at all. A verification that can be
    // satisfied by a different write is not a verification.
    //
    // Excluding it is also simply correct: this row is about to be set to
    // is_default = 1, so clearing it first was never doing anything.
    const clear = await db
      .from("objection_response")
      .update({ is_default: 0, updated_at: now })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("objection_id", objectionId)
      .neq("id", responseId);
    if (clear.error) {
      throw new ObjectionAdminError(`objection_response_default_clear_failed: ${clear.error.message}`);
    }
    update.is_default = 1;
  }

  let write = db
    .from("objection_response")
    .update(update)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", responseId)
    // Scoped here too, not only in the ownership check above. The check proves
    // the pair is valid; this makes the write itself unable to reach a row
    // outside the objection in the URL even if the two ever drift apart.
    .eq("objection_id", objectionId);
  // Same compare-and-swap as updateObjection: a closer can approve this answer
  // between the route reading its status and this write, and an author's
  // wording change must not land on copy that became live in the gap.
  if (expectedStatus !== undefined && expectedStatus !== null) {
    write = write.eq("status", expectedStatus);
  }
  const { error } = await write;
  if (error) throw new ObjectionAdminError(`objection_response_update_failed: ${error.message}`);
  if (expectedStatus !== undefined && expectedStatus !== null) {
    await assertWriteLanded("objection_response", responseId, now);
  }
}

/** Adds one DRAFT answer to an existing objection. Draft for the same reason
 *  a new objection is: the approval gate is not optional.
 *
 *  Takes no author, because `objection_response` has no `created_by` column
 *  (migration 171; only `objection_catalog` has one). Authorship of a response
 *  is recorded at APPROVAL, in `approved_by`, which is the moment that
 *  actually matters: it names who put the sentence in a rep's mouth. */
export async function createDraftResponse(
  objectionId: string,
  input: { label: string; body: string; posture: ObjectionPosture },
): Promise<{ id: string }> {
  const [created] = await createDraftResponses(objectionId, [input]);
  return created;
}

/**
 * Adds SEVERAL draft answers to one objection, all of them or none.
 *
 * Every answer is validated, and every posture checked against both the
 * existing rows and the rest of this batch, BEFORE anything is written. The
 * rows then go in as a single insert.
 *
 * WHY THAT MATTERS RATHER THAN LOOPING. Writing them one at a time means a
 * failure on the second, whether a database error or another request taking
 * that posture first, leaves the first one committed. The caller reports
 * failure while the objection now carries half a set, and a retry then
 * collides with the half that landed. The drafting flow promises all or
 * nothing, and a loop cannot honour that promise.
 */
export async function createDraftResponses(
  objectionId: string,
  inputs: { label: string; body: string; posture: ObjectionPosture }[],
): Promise<{ id: string }[]> {
  if (inputs.length === 0) return [];

  const violations: string[] = [];
  for (const [i, input] of inputs.entries()) {
    const which = inputs.length > 1 ? ` (answer ${i + 1})` : "";
    violations.push(...copyViolations(input.label, `The label${which}`, 60));
    violations.push(...copyViolations(input.body, `The answer${which}`, MAX_BODY_LENGTH));
    if (!isObjectionPosture(input.posture)) {
      violations.push(`"${String(input.posture)}" is not one of the four postures.`);
    }
  }
  if (violations.length) throw new ObjectionRejected("copy_rules", violations.join(" "));

  const withinBatch = inputs.map((i) => i.posture);
  const dupeInBatch = withinBatch.find((p, i) => withinBatch.indexOf(p) !== i);
  if (dupeInBatch) {
    throw new ObjectionRejected(
      "posture_taken",
      `Two of these answers use the same move, "${dupeInBatch}". Each has to be a different one.`,
    );
  }

  const db = getServiceSupabase();
  const siblings = await db
    .from("objection_response")
    .select("posture,status")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("objection_id", objectionId);
  if (siblings.error) {
    throw new ObjectionAdminError(`objection_response_read_failed: ${siblings.error.message}`);
  }
  // Postures must stay distinct within an objection while both rows are live.
  // A second "question it back" gives a rep two buttons with the same name and
  // makes recovery-by-posture compare a posture against itself. A RETIRED row
  // does not block, because its posture is free again.
  const taken = new Set(
    ((siblings.data || []) as { posture: string; status: string }[])
      .filter((s) => s.status !== "retired")
      .map((s) => s.posture),
  );
  const clash = inputs.find((i) => taken.has(i.posture));
  if (clash) {
    throw new ObjectionRejected(
      "posture_taken",
      `This objection already has a live "${clash.posture}" answer. Retire it first, or pick a different move.`,
    );
  }

  const now = new Date().toISOString();
  const rows = inputs.map((input) => ({
    id: randomUUID(),
    tenant_id: WEBDEV_TENANT_ID,
    objection_id: objectionId,
    label: input.label.trim(),
    body: input.body.trim(),
    posture: input.posture,
    is_default: 0,
    status: "draft",
    approved_by: null,
    approved_at: null,
    created_at: now,
    updated_at: now,
  }));

  const { error } = await db.from("objection_response").insert(rows);
  if (error) throw new ObjectionAdminError(`objection_response_insert_failed: ${error.message}`);
  return rows.map((r) => ({ id: r.id }));
}
