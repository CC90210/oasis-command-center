/**
 * lib/offer-pages/operator.ts - what the builder's routes share: the form as
 * this workspace owns it, and the builder's view of its offer page.
 *
 * Every route that uses it has already passed formsSession({ edit: true })
 * (lib/forms/access.ts): an owner or admin of the session's own workspace, in
 * a workspace that is not retired. The workspace is the session's, never the
 * request's, so another workspace's form id matches nothing here (404).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { parseFormBranding, type FormBranding } from "@/lib/forms/types";
import { applyClaimTicks, lintDoc, publishGate, stampConfirmations, type GateResult } from "./claims";
import { readOfferRow, saveDraft, statusOf, type OfferRow } from "./store";
import type { OfferPageDoc } from "./types";

export type EditableForm = { id: string; tenantId: string; slug: string; name: string; enabled: boolean; branding: FormBranding };

export async function editableForm(db: Client, tenantId: string, formId: string): Promise<EditableForm | null> {
  const rs = await db.execute({
    sql: "SELECT id, slug, name, enabled, branding FROM forms WHERE id = ? AND tenant_id = ? LIMIT 1",
    args: [formId, tenantId],
  });
  const r = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!r) return null;
  let branding: FormBranding = {};
  try {
    branding = parseFormBranding(typeof r.branding === "string" ? JSON.parse(r.branding) : r.branding);
  } catch {
    branding = {};
  }
  return {
    id: String(r.id),
    tenantId,
    slug: String(r.slug),
    name: String(r.name ?? ""),
    enabled: Number(r.enabled) === 1,
    branding,
  };
}

/**
 * The words the page falls back to when its own headline is empty: the form's
 * own published headline. Never the form's NAME, which is internal only, so a
 * page with neither is blocked at Publish ("Add a headline").
 */
export function fallbackHeadline(form: Pick<EditableForm, "branding">): string {
  return form.branding.headline || "";
}

export function gateFor(row: OfferRow, form: EditableForm): GateResult | null {
  if (!row.draft) return null;
  return publishGate(row.draft, row.claims, {
    formEnabled: form.enabled,
    fallbackHeadline: fallbackHeadline(form),
    heroBurnedCaptions: row.draftHeroBurnedCaptions,
  });
}

export type DraftSaved =
  | { ok: true; version: number; row: OfferRow }
  | { ok: false; error: "conflict"; currentVersion: number | null }
  | { ok: false; error: "not_found" | "unavailable" };

/**
 * Save a draft the builder's way, for every route that saves one (the
 * builder's PUT, Write my page): every owner confirmation in it is stamped by
 * the server with the saving owner and the time unless it is already on record
 * for the same content (stampConfirmations, against the stored draft and the
 * live page); the claim ticks follow the draft (applyClaimTicks: a tick is kept
 * only for a sentence the draft or the live page flags, `confirm` / `unconfirm`
 * the owner's own); and the write is a compare-and-swap on `expectedVersion`
 * (conflict, never an overwrite). Answers with the new version and the row as
 * read back after the write, so a caller saving twice in one request saves the
 * second time against the first.
 */
export async function saveDraftLikeBuilder(
  db: Client,
  input: {
    form: EditableForm;
    /** The row as read before this save: its draft, live page and ticks are what the save is judged against. */
    row: OfferRow;
    next: OfferPageDoc;
    expectedVersion: number;
    actor: string;
    confirm?: string[];
    unconfirm?: string[];
    now?: string;
  },
): Promise<DraftSaved> {
  const { form, row, actor } = input;
  const now = input.now ?? new Date().toISOString();
  const headline = fallbackHeadline(form);
  const draft = stampConfirmations(input.next, [row.draft, row.published], actor, now);
  const claims = applyClaimTicks({
    existing: row.claims,
    confirm: input.confirm ?? [],
    unconfirm: input.unconfirm ?? [],
    draftHits: lintDoc(draft, { fallbackHeadline: headline }),
    publishedHits: row.published ? lintDoc(row.published, { fallbackHeadline: headline }) : [],
    actor,
    now,
  });
  const saved = await saveDraft(db, { tenantId: form.tenantId, formId: form.id, draft, expectedVersion: input.expectedVersion, claims, actor, now });
  if (!saved.ok) {
    if (saved.error === "conflict") return { ok: false, error: "conflict", currentVersion: saved.currentVersion ?? null };
    return { ok: false, error: saved.error };
  }
  const after = await readOfferRow(db, form.tenantId, form.id);
  if (after.state === "unavailable") return { ok: false, error: "unavailable" };
  if (after.state !== "row") return { ok: false, error: "not_found" };
  return { ok: true, version: saved.version, row: after.row };
}

/** The builder's view of an offer page row. */
export function offerView(row: OfferRow, form: EditableForm) {
  return {
    template: row.template,
    draft: row.draft,
    draft_error: row.draftError,
    version: row.draftVersion,
    draft_updated_at: row.draftUpdatedAt,
    live: row.live,
    status: statusOf(row),
    published_version: row.publishedVersion,
    published_at: row.publishedAt,
    gate: gateFor(row, form),
  };
}
