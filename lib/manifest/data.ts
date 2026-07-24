/**
 * Tenant records CRUD — the data plane behind manifest-driven pages.
 *
 * Every tenant's user-visible data (leads, applications, offers, etc.)
 * lives in `tenant_records` as JSONB wide-rows, keyed by (tenant_id,
 * entity_type). The manifest's `data_model[]` declares the field schema
 * but the table itself is schemaless — fields can be added or removed
 * via the AI editor without a Postgres migration.
 *
 * Tradeoffs:
 *   - PRO: schema changes are instant; multi-tenant indexing is uniform;
 *     RLS is one policy that covers every entity.
 *   - CON: no foreign keys at the DB layer (we enforce in code); JSONB
 *     queries can be slower than native columns at very large row counts
 *     (>1M per tenant). Acceptable until any single tenant proves that
 *     wrong.
 *
 * All exports are server-only. RLS on tenant_records already restricts
 * to current_tenant_id(), so even if a route forgets the explicit
 * tenant filter, Postgres won't return other tenants' rows. Service-role
 * paths still pass tenant_id explicitly because that's the auth-checked
 * value from the route handler — never the value the client requested.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { detectStatusTransitions, publishStatusChange } from "./events";
// Standalone on purpose (no enroller/executor import): executor.ts imports
// THIS file, so the eager drip-cancel lives in its own cycle-free module.
import { cancelStaleDripRunsForLead } from "@/lib/drips/stage-cancel";
import { signFormLink } from "@/lib/form-links";

export class RecordsError extends Error {
  constructor(
    public code: "validation" | "not_found" | "forbidden" | "db",
    message: string
  ) {
    super(message);
    this.name = "RecordsError";
  }
}

export type TenantRecord = {
  id: string;
  tenant_id: string;
  entity_type: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

const ENTITY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_RECORD_LIST_LIMIT = 2_000;

function assertEntity(entity: string): void {
  if (!ENTITY_RE.test(entity)) {
    throw new RecordsError(
      "validation",
      `entity name must match /^[a-z][a-z0-9_]{0,62}$/, got "${entity}"`
    );
  }
}

export type ListRecordsInput = {
  tenant_id: string;
  entity: string;
  /** Sort by data->>field or created_at/updated_at. Prefix with `-` for descending. */
  sort?: string;
  limit?: number;
  offset?: number;
  /** Equality filters on top-level data keys. Values are coerced to strings. */
  where?: Record<string, string | number | boolean | null>;
};

export type ListRecordsResult = {
  rows: TenantRecord[];
  total: number;
};

export async function listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
  assertEntity(input.entity);
  const limit = Math.max(1, Math.min(input.limit ?? 100, MAX_RECORD_LIST_LIMIT));
  const offset = Math.max(0, input.offset ?? 0);
  const db = getServiceSupabase();

  let q = db
    .from("tenant_records")
    .select("id, tenant_id, entity_type, data, created_at, updated_at", { count: "exact" })
    .eq("tenant_id", input.tenant_id)
    .eq("entity_type", input.entity);

  // Apply data-shape filters. We coerce values to strings because JSONB
  // top-level equality through PostgREST's `data->>key.eq.value` syntax
  // returns text-typed values.
  if (input.where) {
    for (const [k, v] of Object.entries(input.where)) {
      if (v === null) {
        q = q.is(`data->>${k}`, null);
      } else {
        q = q.eq(`data->>${k}`, String(v));
      }
    }
  }

  // Transferred leads have graduated into the Applications pipeline. Exclude them
  // from EVERY lead LIST surface (single + combined pipeline, dashboard counts,
  // kanban, search, exports) so a transferred deal never resurfaces as a lead
  // card. One source of truth at the read layer (Bravo follow-up 2026-06-21);
  // the client-side LeadPipelineView filter stays as defense-in-depth. Lead
  // DETAIL via getRecord is intentionally unaffected (a transferred lead is
  // still openable by id). Applications never carry transferred_at.
  if (input.entity === "lead") {
    q = q.is("data->>transferred_at", null);
  } else if (input.entity === "application") {
    // Mirror of the lead filter: only deals EXPLICITLY transferred from a lead
    // (or standalone apps) belong on the Applications board. "Run underwriting"
    // and doc-extraction create a backing application while the deal is still a
    // lead — those carry no promoted_at and stay hidden until the operator clicks
    // "Transfer to Application" (which stamps promoted_at). Prevents the deal
    // showing on BOTH boards. Application DETAIL via getRecord is unaffected.
    q = q.not("data->>promoted_at", "is", null);
  }

  if (input.sort) {
    const desc = input.sort.startsWith("-");
    const col = (desc ? input.sort.slice(1) : input.sort).trim();
    if (col === "created_at" || col === "updated_at") {
      q = q.order(col, { ascending: !desc });
    } else {
      // Sort by a JSONB field via PostgREST's `data->>field` ordering.
      q = q.order(`data->>${col}`, { ascending: !desc });
    }
  } else {
    q = q.order("updated_at", { ascending: false });
  }

  q = q.range(offset, offset + limit - 1);

  const result = await q;
  if (result.error) throw new RecordsError("db", result.error.message);
  return {
    rows: (result.data || []) as TenantRecord[],
    total: result.count || 0,
  };
}

const UUID_RE_SCOPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * List the records a single AGENT may see: those they own (`data.assigned_to`)
 * OR collaborate on (`data.collaborators` array contains their id). Two indexed
 * reads merged + paginated in memory — an agent's book is bounded, and this
 * sidesteps the fragile jsonb `.or()` filter-string encoding. The owned read
 * reuses listRecords (so the lead `transferred_at` exclusion + entity guards
 * apply); the shared read mirrors them. NOTE: supabase-js encodes an array arg
 * to `.contains` as a Postgres array literal `{…}`, which is WRONG for a jsonb
 * array column — so we pass `JSON.stringify([id])` to get the jsonb `["id"]`
 * containment (`data->collaborators @> '["id"]'`).
 *
 * Admin / all / unassigned reads do NOT use this — they call listRecords with a
 * `where` (or none) so admins keep full visibility + narrowing.
 */
export async function listRecordsForViewer(input: {
  tenant_id: string;
  entity: string;
  /** lowercased auth_user_id of the viewing agent */
  userId: string;
  sort?: string;
  limit?: number;
  offset?: number;
}): Promise<ListRecordsResult> {
  assertEntity(input.entity);
  const id = input.userId.toLowerCase();
  // Fail-closed: a non-UUID viewer id can never own/collaborate on a real row.
  if (!UUID_RE_SCOPE.test(id)) return { rows: [], total: 0 };
  const db = getServiceSupabase();

  // Owned — reuse listRecords so the transferred_at exclusion + sort apply.
  const ownedPromise = listRecords({
    tenant_id: input.tenant_id,
    entity: input.entity,
    where: { assigned_to: id },
    limit: MAX_RECORD_LIST_LIMIT,
  });

  // Shared — collaborators jsonb array contains id. Mirror listRecords' lead
  // transferred_at exclusion.
  let sq = db
    .from("tenant_records")
    .select("id, tenant_id, entity_type, data, created_at, updated_at")
    .eq("tenant_id", input.tenant_id)
    .eq("entity_type", input.entity)
    .contains("data->collaborators", JSON.stringify([id]))
    .limit(MAX_RECORD_LIST_LIMIT);
  if (input.entity === "lead") sq = sq.is("data->>transferred_at", null);

  // Owned + shared are independent reads (merged by id below, order-independent)
  // — run them as ONE parallel DB wave instead of two serial round-trips. This
  // resolver backs every scoped board/pipeline/KPI read for non-admin reps, so
  // the saved round-trip multiplies across entities (perf, 2026-06-25).
  const [owned, sharedRes] = await Promise.all([ownedPromise, sq]);
  if (sharedRes.error) throw new RecordsError("db", sharedRes.error.message);
  const shared = (sharedRes.data || []) as TenantRecord[];

  // Merge unique by id (a row could be both owned and self-collaborated).
  const byId = new Map<string, TenantRecord>();
  for (const r of owned.rows) byId.set(r.id, r);
  for (const r of shared) byId.set(r.id, r);
  const merged = sortTenantRecords([...byId.values()], input.sort);

  const limit = Math.max(1, Math.min(input.limit ?? 100, MAX_RECORD_LIST_LIMIT));
  const offset = Math.max(0, input.offset ?? 0);
  return { rows: merged.slice(offset, offset + limit), total: merged.length };
}

/**
 * List records for a resolved assigned-scope (from lib/lead-scope
 * resolveAssignedScope). ONE interpretation of the scope value, shared by the
 * records API, the catch-all pipeline page, and the dashboard so visibility
 * can't drift between surfaces:
 *   undefined → all (admin, no narrowing)
 *   null      → unassigned bucket (admin ?unassigned)
 *   <userId>  → that user's board = owned OR collaborated (agent's own board,
 *               OR admin narrowing to one rep). Non-UUID (e.g. NO_LEADS
 *               fail-closed sentinel) → empty, via listRecordsForViewer.
 */
export async function listByAssignedScope(input: {
  tenant_id: string;
  entity: string;
  scope: string | null | undefined;
  limit?: number;
  offset?: number;
  sort?: string;
}): Promise<ListRecordsResult> {
  const { tenant_id, entity, scope, limit, offset, sort } = input;
  if (scope === undefined) {
    return listRecords({ tenant_id, entity, limit, offset, sort });
  }
  if (scope === null) {
    return listRecords({ tenant_id, entity, limit, offset, sort, where: { assigned_to: null } });
  }
  return listRecordsForViewer({ tenant_id, entity, userId: scope, limit, offset, sort });
}

/** In-memory sort matching listRecords' semantics (default: updated_at desc).
 *  `-field` = descending; created_at/updated_at sort on the column, anything
 *  else on data[field]. */
export function sortTenantRecords(rows: TenantRecord[], sort?: string): TenantRecord[] {
  const spec = (sort || "-updated_at").trim();
  const desc = spec.startsWith("-");
  const col = (desc ? spec.slice(1) : spec).trim();
  const keyOf = (r: TenantRecord): string | number => {
    if (col === "created_at") return r.created_at || "";
    if (col === "updated_at") return r.updated_at || "";
    const v = r.data[col];
    return typeof v === "number" ? v : typeof v === "string" ? v : "";
  };
  return [...rows].sort((a, b) => {
    const av = keyOf(a);
    const bv = keyOf(b);
    if (av < bv) return desc ? 1 : -1;
    if (av > bv) return desc ? -1 : 1;
    return 0;
  });
}

export async function getRecord(input: { tenant_id: string; entity: string; id: string }): Promise<TenantRecord | null> {
  assertEntity(input.entity);
  const db = getServiceSupabase();
  const result = await db
    .from("tenant_records")
    .select("id, tenant_id, entity_type, data, created_at, updated_at")
    .eq("tenant_id", input.tenant_id)
    .eq("entity_type", input.entity)
    .eq("id", input.id)
    .maybeSingle();
  if (result.error) throw new RecordsError("db", result.error.message);
  return (result.data || null) as TenantRecord | null;
}

// Stages at which the merchant-facing application URL is useful to have
// stamped on the lead row. Drip templates reference {{lead.application_url}}
// for the apply-now CTA — if the lead's data doesn't carry the URL, that
// substitution comes out empty and the message lands broken. Phase 2 of
// Adon's MCA architecture (2026-06-08) closes this by auto-stamping the
// URL at the moment the lead enters one of these stages.
//
// Stages NOT in this list (declined, default, opted_out, renewed_elsewhere)
// don't need a fresh URL — the merchant's path is closed.
const STAGES_NEEDING_APPLY_URL = new Set([
  "intent_inquiry_submitted",
  "hot_lead",
  "new_contact",
  "uw_sheet", // Live Subs — the first-touch drip texts the application link
  "missing_info",
  "follow_up",
  "sent_application",
  "viewed_application",
  "signed_application", // the bank-statements nag drip links back to their form to finish uploading
  // (note: "declined" is intentionally NOT here — a lead's data.stage is never
  //  "declined"; decline lives on the APPLICATION status, so it can't mint here.)
  "ghost", // re-engagement merchants still need a working link
]);

/**
 * Look up the tenant's full application form. Returns null if the
 * tenant has no enabled form (cleanly skips URL stamping — sequence
 * templates handle the empty variable as plain text). Picks the form
 * whose slug explicitly identifies the full application. Only then fall back
 * to another application-shaped form. The previous selector preferred
 * `initial-lead-capture`, which sent merchants at Sent Application back to the
 * short lead form instead of their actual application.
 *
 * Uses Supabase's foreign-table embed (`tenant:tenants!inner(slug)`)
 * to fetch tenant.slug in ONE query — matches the pattern used by
 * app/api/forms/submit/route.ts:225 + mint-link/route.ts:38.
 *
 * Schema source of truth: database/042_tenant_forms.sql.
 *   - Table is `forms` (NOT `tenant_forms` despite the migration filename).
 *   - Active flag is `enabled` (NOT `published`).
 */
async function resolveIntakeForm(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
): Promise<{ id: string; slug: string; tenant_slug: string } | null> {
  try {
    const formsRes = await db
      .from("forms")
      .select("id, slug, tenant:tenants!inner(slug)")
      .eq("tenant_id", tenantId)
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    type FormRow = {
      id: string;
      slug: string;
      tenant: { slug: string } | { slug: string }[] | null;
    };
    const forms = (formsRes.data || []) as FormRow[];
    if (forms.length === 0) return null;
    const fullApplication = forms.find((f) => {
      const s = (f.slug || "").toLowerCase();
      return s === "full-application" || s === "full_application";
    });
    const applicationMatch = forms.find((f) => {
      const s = (f.slug || "").toLowerCase();
      return (
        s.includes("full") && (s.includes("application") || s.includes("apply"))
      );
    });
    const chosen = fullApplication || applicationMatch;
    if (!chosen) return null; // fail closed: never substitute the lead-capture form
    // Supabase REST may flatten or array-wrap the embed depending on
    // FK shape — handle both.
    const tenantSlug = Array.isArray(chosen.tenant)
      ? chosen.tenant[0]?.slug
      : chosen.tenant?.slug;
    if (!tenantSlug) return null;
    return { id: chosen.id, slug: chosen.slug, tenant_slug: tenantSlug };
  } catch {
    return null;
  }
}

/**
 * If the lead row needs an application URL (relevant stage, no URL yet,
 * lead entity), mint one via signFormLink and return the URL string.
 * Returns null when nothing should be stamped — caller treats null as
 * "leave data alone." Best-effort: any failure (no form, no HMAC key,
 * supabase blip) returns null silently so the parent create/update
 * never crashes on a side-effect.
 */
export async function maybeMintApplicationUrl(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  entity: string,
  recordId: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  if (entity !== "lead") return null;
  if (typeof data.application_url === "string" && data.application_url.trim()) {
    return null; // already stamped
  }
  const stage = typeof data.stage === "string" ? data.stage : "";
  if (!STAGES_NEEDING_APPLY_URL.has(stage)) return null;
  const form = await resolveIntakeForm(db, tenantId);
  if (!form) return null;
  const token = signFormLink({
    tenant: form.tenant_slug,
    form_id: form.id,
    lead_id: recordId,
  });
  if (!token) return null; // HMAC key missing in production — fail-closed
  const origin =
    process.env.OASIS_PUBLIC_ORIGIN ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://oasisai.work";
  return `${origin.replace(/\/$/, "")}/f/${form.tenant_slug}/${form.slug}/${token}`;
}

export type CreateRecordInput = {
  tenant_id: string;
  entity: string;
  data: Record<string, unknown>;
};

export async function createRecord(input: CreateRecordInput): Promise<TenantRecord> {
  assertEntity(input.entity);
  if (!input.data || typeof input.data !== "object") {
    throw new RecordsError("validation", "data must be an object");
  }
  const db = getServiceSupabase();
  const result = await db
    .from("tenant_records")
    .insert({
      tenant_id: input.tenant_id,
      entity_type: input.entity,
      data: input.data,
    })
    .select("id, tenant_id, entity_type, data, created_at, updated_at")
    .single();
  if (result.error) throw new RecordsError("db", result.error.message);
  const row = result.data as TenantRecord;

  // Adon Phase 2 (2026-06-08): stamp data.application_url so drip
  // templates can substitute the apply-now CTA. Best-effort — failure
  // returns null and we proceed without the URL.
  const mintedUrl = await maybeMintApplicationUrl(
    db,
    row.tenant_id,
    row.entity_type,
    row.id,
    row.data,
  );
  if (mintedUrl) {
    const updated = { ...row.data, application_url: mintedUrl };
    const patchRes = await db
      .from("tenant_records")
      .update({ data: updated, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select("data, updated_at")
      .single();
    if (!patchRes.error && patchRes.data) {
      row.data = (patchRes.data as { data: Record<string, unknown> }).data;
      row.updated_at = (patchRes.data as { updated_at: string }).updated_at;
    }
  }

  // Phase 2: emit BRAVO_RECORD_STATUS_CHANGED for the initial stage/status
  // value so the drip engine (Phase 4) can fire the "new lead" sequence
  // when a lead lands with stage="cold". detectStatusTransitions treats
  // before=null as a real transition for this case. URL stamp above runs
  // FIRST so the sequence_runner sees the URL when it renders the template.
  const transitions = detectStatusTransitions(null, row.data);
  for (const t of transitions) {
    await publishStatusChange({
      tenantId: input.tenant_id,
      entity: input.entity,
      recordId: row.id,
      field: t.field,
      from: t.from,
      to: t.to,
      data: row.data,
    });
  }

  return row;
}

export type UpdateRecordInput = {
  tenant_id: string;
  entity: string;
  id: string;
  patch: Record<string, unknown>;
};

export async function updateRecord(input: UpdateRecordInput): Promise<TenantRecord> {
  assertEntity(input.entity);
  const existing = await getRecord({ tenant_id: input.tenant_id, entity: input.entity, id: input.id });
  if (!existing) throw new RecordsError("not_found", "record not found");
  const merged = { ...existing.data, ...input.patch };
  const db = getServiceSupabase();
  const result = await db
    .from("tenant_records")
    .update({ data: merged, updated_at: new Date().toISOString() })
    .eq("id", input.id)
    .eq("tenant_id", input.tenant_id)
    .eq("entity_type", input.entity)
    .select("id, tenant_id, entity_type, data, created_at, updated_at")
    .single();
  if (result.error) throw new RecordsError("db", result.error.message);
  let row = result.data as TenantRecord;

  // Adon Phase 2: stamp data.application_url on every transition into a
  // stage that needs the apply-now CTA. Only mints when the URL is
  // missing (idempotent) — operator overrides via the dashboard are
  // preserved. Runs BEFORE publishStatusChange so the sequence_runner
  // always reads the URL-stamped state.
  const mintedUrl = await maybeMintApplicationUrl(
    db,
    row.tenant_id,
    row.entity_type,
    row.id,
    row.data,
  );
  if (mintedUrl) {
    const updated = { ...row.data, application_url: mintedUrl };
    const patchRes = await db
      .from("tenant_records")
      .update({ data: updated, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select("id, tenant_id, entity_type, data, created_at, updated_at")
      .single();
    if (!patchRes.error && patchRes.data) {
      row = patchRes.data as TenantRecord;
    }
  }

  // Phase 2: emit BRAVO_RECORD_STATUS_CHANGED on every stage/status
  // transition. Drip engine (Phase 4) subscribes to fire next sequence
  // step; /feed surfaces them as live signals. Diffing against the
  // pre-update row's data — so a patch that doesn't touch stage/status
  // produces zero events (the loop body never runs).
  const transitions = detectStatusTransitions(existing.data, row.data);
  for (const t of transitions) {
    await publishStatusChange({
      tenantId: input.tenant_id,
      entity: input.entity,
      recordId: row.id,
      field: t.field,
      from: t.from,
      to: t.to,
      data: row.data,
    });
  }

  // Debounce stale drips (2026-07-22 stage-buffer fix): the moment a lead
  // changes stage, flush its pending prior-stage drip rows; when an
  // application advances to shopping, flush ALL of the linked lead's stage
  // drips (shop-out moves the application's status, not the lead's stage).
  // cancelStaleDripRunsForLead never throws (fail-soft) — a drip hiccup must
  // not fail the stage write, and the dispatcher's stage/shopped rechecks
  // remain the backstop.
  if (transitions.length > 0) {
    if (input.entity === "lead") {
      const stageT = transitions.find((t) => t.field === "stage" && typeof ((t as { to: unknown }).to) === "string");
      if (stageT) {
        await cancelStaleDripRunsForLead(
          db,
          input.tenant_id,
          row.id,
          String(stageT.to),
          `stage_changed_eager: lead moved to ${String(stageT.to)}`,
        );
      }
    } else if (input.entity === "application") {
      const shopped = transitions.some((t) => t.field === "status" && t.to === "shopping");
      const leadId =
        typeof (row.data as Record<string, unknown>).lead_id === "string"
          ? String((row.data as Record<string, unknown>).lead_id)
          : null;
      if (shopped && leadId) {
        await cancelStaleDripRunsForLead(
          db,
          input.tenant_id,
          leadId,
          null,
          "shopped_out_eager: application moved to shopping",
        );
      }
    }
  }

  return row;
}

export async function deleteRecord(input: { tenant_id: string; entity: string; id: string }): Promise<void> {
  assertEntity(input.entity);
  const db = getServiceSupabase();
  // Round 3 R3-9: ask for an exact row count so a no-op delete (id
  // doesn't match, or tenant scope is wrong) surfaces as a "not_found"
  // error instead of silently returning ok. Mirrors the pattern from
  // commit fcec21d that closed the same gap on /api/sequences and
  // /api/forms — the catch-all manifest DELETE route was missed.
  const result = await db
    .from("tenant_records")
    .delete({ count: "exact" })
    .eq("id", input.id)
    .eq("tenant_id", input.tenant_id)
    .eq("entity_type", input.entity);
  if (result.error) throw new RecordsError("db", result.error.message);
  if (!result.count) {
    throw new RecordsError("not_found", "record not found or not in tenant scope");
  }
}

/** Convenience — group records by a top-level data key for kanban views. */
export function groupRecordsBy(
  rows: TenantRecord[],
  field: string
): Record<string, TenantRecord[]> {
  const out: Record<string, TenantRecord[]> = {};
  for (const row of rows) {
    const key = String(row.data[field] ?? "(unset)");
    if (!out[key]) out[key] = [];
    out[key].push(row);
  }
  return out;
}

/**
 * Render a JSONB value as a display string for the table cells. Keeps the
 * table primitive simple — it never has to deserialise complex shapes.
 */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatFieldValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
