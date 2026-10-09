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
import { publishGate, type GateResult } from "./claims";
import { statusOf, type OfferRow } from "./store";

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
  return publishGate(row.draft, row.claims, { formEnabled: form.enabled, fallbackHeadline: fallbackHeadline(form) });
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
