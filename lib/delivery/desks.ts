/**
 * lib/delivery/desks.ts — which workspaces run a support desk, and the form
 * that feeds each one.
 *
 *   OASIS    its desk has always existed. Its form is the one migration 183
 *            seeded at /f/oasis-ai-cc/support, recognised by that exact
 *            (tenant, slug) pair with no query (support-intake.ts
 *            isSupportFormSubmission), exactly as before.
 *   others   a workspace's owner turns its form on from the Support desk
 *            (enableSupportDesk). That writes a `forms` row with slug
 *            `support` AND a `support_desks` row naming it (migration
 *            bravo__188). The registration is what makes /f/<slug>/support a
 *            ticket form: a workspace may already own a LEAD form whose slug
 *            happens to be `support`, and that form keeps creating leads.
 *
 * No `server-only`: tests drive this against a local libSQL file. Every
 * statement binds a tenant, except the two whole-platform reads the SLA cron
 * and the public intake need (listRegisteredDesks, findRegisteredDeskBySlug),
 * which read the registry itself and return each desk WITH its tenant, so what
 * runs next is scoped to that tenant.
 */
import { randomUUID } from "node:crypto";
import type { Client, ResultSet } from "@libsql/client";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";
import {
  SUPPORT_FORM_PATH,
  SUPPORT_FORM_SLUG,
  SUPPORT_FORM_TENANT_SLUG,
  buildWorkspaceSupportFormRow,
  supportFormPathFor,
} from "@/lib/delivery/support-form";

export type SupportDesk = {
  tenantId: string;
  tenantSlug: string;
  /** The desk's form id; null for OASIS, whose form is recognised by tenant + slug. */
  formId: string | null;
  oasis: boolean;
};

/** OASIS's desk: the vendor desk, fed by /f/oasis-ai-cc/support. */
export const OASIS_DESK: SupportDesk = {
  tenantId: DELIVERY_TENANT_ID,
  tenantSlug: SUPPORT_FORM_TENANT_SLUG,
  formId: null,
  oasis: true,
};

function rows(rs: ResultSet): Array<Record<string, unknown>> {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown as unknown[])[i];
    });
    return o;
  });
}

/** "support_desks does not exist yet" (migration bravo__188 not applied): no registered desks. */
function isMissingRegistry(err: unknown): boolean {
  return /no such table: support_desks\b/i.test(err instanceof Error ? err.message : String(err));
}

let registryMissingLogged = false;
function noteRegistryMissing(where: string) {
  if (registryMissingLogged) return;
  registryMissingLogged = true;
  console.error(`[delivery.desks.${where}] support_desks is missing (migration bravo__188 not applied): only OASIS's desk takes form tickets`);
}

/** Every workspace desk registered through enableSupportDesk (OASIS's own is not in the registry). */
export async function listRegisteredDesks(db: Client): Promise<SupportDesk[]> {
  try {
    const rs = await db.execute({
      sql: `SELECT d.tenant_id, d.form_id, t.slug
            FROM support_desks d JOIN tenants t ON t.id = d.tenant_id
            ORDER BY d.enabled_at, d.tenant_id`,
      args: [],
    });
    return rows(rs)
      .filter((r) => String(r.tenant_id) !== DELIVERY_TENANT_ID)
      .map((r) => ({ tenantId: String(r.tenant_id), tenantSlug: String(r.slug ?? ""), formId: String(r.form_id), oasis: false }));
  } catch (err) {
    if (!isMissingRegistry(err)) throw err;
    noteRegistryMissing("list");
    return [];
  }
}

/**
 * The registered desk behind /f/<tenantSlug>/support, or null when that
 * workspace has none (its `support` form, if any, is an ordinary lead form).
 */
export async function findRegisteredDeskBySlug(db: Client, tenantSlug: string): Promise<SupportDesk | null> {
  try {
    const rs = await db.execute({
      sql: `SELECT d.tenant_id, d.form_id, t.slug
            FROM support_desks d
            JOIN tenants t ON t.id = d.tenant_id
            JOIN forms f ON f.id = d.form_id AND f.tenant_id = d.tenant_id
            WHERE t.slug = ? AND f.slug = ?
            LIMIT 1`,
      args: [tenantSlug, SUPPORT_FORM_SLUG],
    });
    const r = rows(rs)[0];
    if (!r || String(r.tenant_id) === DELIVERY_TENANT_ID) return null;
    return { tenantId: String(r.tenant_id), tenantSlug: String(r.slug ?? tenantSlug), formId: String(r.form_id), oasis: false };
  } catch (err) {
    if (!isMissingRegistry(err)) throw err;
    noteRegistryMissing("find");
    return null;
  }
}

export type DeskFormState =
  | { state: "on"; path: string; formId: string | null; enabled: boolean }
  | { state: "off" }
  /** The workspace owns a non-desk form with slug `support`; turning the desk on would hijack it. */
  | { state: "slug_taken"; formId: string }
  /** support_desks is missing: migration bravo__188 has not been applied here. */
  | { state: "unavailable" };

/** Is this workspace's public support form on, and where is it? Scoped to `tenantId`. */
export async function getDeskForm(db: Client, tenantId: string, tenantSlug: string | null): Promise<DeskFormState> {
  if (tenantId === DELIVERY_TENANT_ID) {
    const rs = await db.execute({
      sql: "SELECT id, enabled FROM forms WHERE tenant_id = ? AND slug = ? LIMIT 1",
      args: [tenantId, SUPPORT_FORM_SLUG],
    });
    const r = rows(rs)[0];
    return r ? { state: "on", path: SUPPORT_FORM_PATH, formId: String(r.id), enabled: Number(r.enabled) === 1 } : { state: "off" };
  }
  let desk: Record<string, unknown> | undefined;
  try {
    desk = rows(
      await db.execute({
        sql: `SELECT d.form_id, f.id AS live_form_id, f.enabled FROM support_desks d
              LEFT JOIN forms f ON f.id = d.form_id AND f.tenant_id = d.tenant_id
              WHERE d.tenant_id = ? LIMIT 1`,
        args: [tenantId],
      }),
    )[0];
  } catch (err) {
    if (!isMissingRegistry(err)) throw err;
    // The screens say only that the form isn't available; the cause is here, every time.
    console.error("[delivery.desks.form] support_desks is missing (migration bravo__188 not applied): the support form cannot be shown or turned on");
    return { state: "unavailable" };
  }
  // A registration whose form is gone (deleted through the Forms page before
  // that was refused) is NOT a desk that is on: intake cannot find it, so it
  // reads as off here and enableSupportDesk re-creates the form and replaces
  // the stale registration (Codex, PR #473).
  if (desk && desk.live_form_id != null) {
    return {
      state: "on",
      path: supportFormPathFor(tenantSlug ?? ""),
      formId: String(desk.form_id),
      enabled: Number(desk.enabled) === 1,
    };
  }
  const existing = rows(
    await db.execute({ sql: "SELECT id FROM forms WHERE tenant_id = ? AND slug = ? LIMIT 1", args: [tenantId, SUPPORT_FORM_SLUG] }),
  )[0];
  return existing ? { state: "slug_taken", formId: String(existing.id) } : { state: "off" };
}

export type EnableResult =
  | { ok: true; created: boolean; formId: string; path: string }
  | { ok: false; status: 409 | 404 | 503; error: "support_slug_taken" | "tenant_not_found" | "support_desk_unavailable" | "oasis_desk_is_seeded" };

/**
 * Turn a workspace's public support form on: create its `support` form and
 * register it as the desk's intake, in one batch. Idempotent: a desk that is
 * already on returns its form (created: false). Refuses when the workspace
 * already owns a `support` form that is not its desk's (it would stop creating
 * the leads it creates today). The tenant is the caller's SESSION tenant.
 */
export async function enableSupportDesk(
  db: Client,
  tenantId: string,
  actor: string | null,
  now: Date,
): Promise<EnableResult> {
  if (tenantId === DELIVERY_TENANT_ID) return { ok: false, status: 409, error: "oasis_desk_is_seeded" };
  const tenant = rows(
    await db.execute({ sql: "SELECT id, slug, name, logo_url FROM tenants WHERE id = ? LIMIT 1", args: [tenantId] }),
  )[0];
  if (!tenant) return { ok: false, status: 404, error: "tenant_not_found" };
  const slug = String(tenant.slug ?? "");
  const state = await getDeskForm(db, tenantId, slug);
  if (state.state === "unavailable") return { ok: false, status: 503, error: "support_desk_unavailable" };
  if (state.state === "on") return { ok: true, created: false, formId: state.formId ?? "", path: state.path };
  if (state.state === "slug_taken") return { ok: false, status: 409, error: "support_slug_taken" };

  const row = buildWorkspaceSupportFormRow({
    id: tenantId,
    name: String(tenant.name ?? slug ?? "Support"),
    logo_url: tenant.logo_url ? String(tenant.logo_url) : null,
  });
  const formId = randomUUID();
  const at = now.toISOString();
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO forms (id, tenant_id, slug, name, description, branding, steps, on_complete_stage, step_outcomes,
                                   enabled, redirect_url, created_by, created_at, updated_at)
                SELECT ?, ?, ?, ?, ?, ?, ?, NULL, '{}', 1, NULL, ?, ?, ?
                WHERE NOT EXISTS (SELECT 1 FROM forms WHERE tenant_id = ? AND slug = ?)`,
          args: [
            formId,
            tenantId,
            row.slug,
            row.name,
            row.description,
            JSON.stringify(row.branding),
            JSON.stringify(row.steps),
            actor,
            at,
            at,
            tenantId,
            row.slug,
          ],
        },
        {
          // Registers only the form this batch just wrote: a racing request that
          // wrote its own form first leaves this INSERT matching nothing. An
          // existing registration is replaced ONLY when its form is gone (a
          // stale desk); a live desk's registration is never taken over.
          sql: `INSERT INTO support_desks (tenant_id, form_id, enabled_by, enabled_at)
                SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM forms WHERE id = ? AND tenant_id = ?)
                ON CONFLICT (tenant_id) DO UPDATE SET
                  form_id = excluded.form_id, enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at
                WHERE NOT EXISTS (
                  SELECT 1 FROM forms WHERE id = support_desks.form_id AND tenant_id = support_desks.tenant_id
                )`,
          args: [tenantId, formId, actor, at, formId, tenantId],
        },
      ],
      "write",
    );
  } catch (err) {
    if (!isUniqueViolationError(err as { message?: string })) throw err;
    // Two owners pressed the button at once: the other request registered first.
  }
  const after = await getDeskForm(db, tenantId, slug);
  if (after.state === "on") return { ok: true, created: after.formId === formId, formId: after.formId ?? formId, path: after.path };
  if (after.state === "slug_taken") return { ok: false, status: 409, error: "support_slug_taken" };
  throw new Error(`enableSupportDesk: desk for ${tenantId} is ${after.state} after enabling`);
}
