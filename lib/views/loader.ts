/**
 * Saved-view loader — V6.9.1 substrate.
 *
 * Reads `views` + `view_fields` + `view_filters` + `view_sorts` rows
 * (migration 071) and translates them into a shape the existing manifest
 * renderers (ManifestTable, ManifestKanban) can apply over a Supabase query.
 *
 * Resolution order:
 *   1. viewId passed explicitly → load that view (any owner)
 *   2. Per-user default for (tenant, object_metadata_id) → if the caller is
 *      passed in, prefer their owned view
 *   3. Workspace-shared is_default=true row
 *   4. null → caller falls back to URL-param filtering (legacy behavior)
 */

import { cache } from "react";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";

export type ViewKind = "table" | "kanban" | "calendar" | "gallery";

export type ViewFilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "starts_with"
  | "in"
  | "is_null";

export type LoadedViewField = {
  id: string;
  field_metadata_id: string;
  field_name: string;
  position: number;
  width: number | null;
  is_visible: boolean;
};

export type LoadedViewFilter = {
  id: string;
  field_metadata_id: string;
  field_name: string;
  operator: ViewFilterOperator;
  value: unknown;
  conjunction: "AND" | "OR";
  position: number;
};

export type LoadedViewSort = {
  id: string;
  field_metadata_id: string;
  field_name: string;
  direction: "ASC" | "DESC";
  position: number;
};

export type LoadedView = {
  id: string;
  tenant_id: string;
  object_metadata_id: string;
  slug: string;
  name: string;
  kind: ViewKind;
  owner_user_id: string | null;
  is_default: boolean;
  kanban_field_name: string | null;
  description: string | null;
  fields: LoadedViewField[];
  filters: LoadedViewFilter[];
  sorts: LoadedViewSort[];
};

type ViewRow = {
  id: string;
  tenant_id: string;
  object_metadata_id: string;
  slug: string;
  name: string;
  kind: ViewKind;
  owner_user_id: string | null;
  is_default: boolean;
  kanban_field_name: string | null;
  description: string | null;
};

type FieldRow = {
  id: string;
  view_id: string;
  field_metadata_id: string;
  position: number;
  width: number | null;
  is_visible: boolean;
};

type FilterRow = {
  id: string;
  view_id: string;
  field_metadata_id: string;
  operator: ViewFilterOperator;
  value: unknown;
  conjunction: "AND" | "OR";
  position: number;
};

type SortRow = {
  id: string;
  view_id: string;
  field_metadata_id: string;
  direction: "ASC" | "DESC";
  position: number;
};

type FieldNameMap = Map<string, string>;

async function loadFieldNames(fieldIds: string[]): Promise<FieldNameMap> {
  if (fieldIds.length === 0) return new Map();
  return safe(
    "views.loader.loadFieldNames",
    (async () => {
      const db = getServiceSupabase();
      const result = await db
        .from("field_metadata")
        .select("id, name")
        .in("id", fieldIds);
      const rows = (result.data || []) as Array<{ id: string; name: string }>;
      return new Map(rows.map((r) => [r.id, r.name]));
    })(),
    new Map() as FieldNameMap,
  );
}

async function hydrate(view: ViewRow): Promise<LoadedView> {
  const db = getServiceSupabase();
  const [fieldsRes, filtersRes, sortsRes] = await Promise.all([
    db.from("view_fields").select("id, view_id, field_metadata_id, position, width, is_visible").eq("view_id", view.id).order("position", { ascending: true }),
    db.from("view_filters").select("id, view_id, field_metadata_id, operator, value, conjunction, position").eq("view_id", view.id).order("position", { ascending: true }),
    db.from("view_sorts").select("id, view_id, field_metadata_id, direction, position").eq("view_id", view.id).order("position", { ascending: true }),
  ]);

  const fieldRows = (fieldsRes.data || []) as FieldRow[];
  const filterRows = (filtersRes.data || []) as FilterRow[];
  const sortRows = (sortsRes.data || []) as SortRow[];

  const fieldIds = Array.from(
    new Set<string>([
      ...fieldRows.map((f) => f.field_metadata_id),
      ...filterRows.map((f) => f.field_metadata_id),
      ...sortRows.map((s) => s.field_metadata_id),
    ]),
  );
  const fieldNames = await loadFieldNames(fieldIds);
  const resolveName = (id: string): string => fieldNames.get(id) ?? id;

  return {
    id: view.id,
    tenant_id: view.tenant_id,
    object_metadata_id: view.object_metadata_id,
    slug: view.slug,
    name: view.name,
    kind: view.kind,
    owner_user_id: view.owner_user_id,
    is_default: view.is_default,
    kanban_field_name: view.kanban_field_name,
    description: view.description,
    fields: fieldRows.map((f) => ({
      id: f.id,
      field_metadata_id: f.field_metadata_id,
      field_name: resolveName(f.field_metadata_id),
      position: f.position,
      width: f.width,
      is_visible: f.is_visible,
    })),
    filters: filterRows.map((f) => ({
      id: f.id,
      field_metadata_id: f.field_metadata_id,
      field_name: resolveName(f.field_metadata_id),
      operator: f.operator,
      value: f.value,
      conjunction: f.conjunction,
      position: f.position,
    })),
    sorts: sortRows.map((s) => ({
      id: s.id,
      field_metadata_id: s.field_metadata_id,
      field_name: resolveName(s.field_metadata_id),
      direction: s.direction,
      position: s.position,
    })),
  };
}

/** Load a single view by id. Returns null if not found or inaccessible. */
export const loadView = cache(async (viewId: string): Promise<LoadedView | null> => {
  return safe(
    "views.loader.loadView",
    (async () => {
      const db = getServiceSupabase();
      const result = await db
        .from("views")
        .select("id, tenant_id, object_metadata_id, slug, name, kind, owner_user_id, is_default, kanban_field_name, description")
        .eq("id", viewId)
        .eq("is_active", true)
        .maybeSingle();
      const row = (result.data || null) as ViewRow | null;
      if (!row) return null;
      return hydrate(row);
    })(),
    null as LoadedView | null,
  );
});

/** List all views for a (tenant, object) pair. Workspace + per-user owned. */
export const loadViewsForObject = cache(
  async (tenantId: string, objectMetadataId: string, userId?: string | null): Promise<LoadedView[]> => {
    return safe(
      "views.loader.loadViewsForObject",
      (async () => {
        const db = getServiceSupabase();
        let query = db
          .from("views")
          .select("id, tenant_id, object_metadata_id, slug, name, kind, owner_user_id, is_default, kanban_field_name, description")
          .eq("tenant_id", tenantId)
          .eq("object_metadata_id", objectMetadataId)
          .eq("is_active", true)
          .order("is_default", { ascending: false })
          .order("name", { ascending: true });

        if (userId) {
          query = query.or(`owner_user_id.is.null,owner_user_id.eq.${userId}`);
        } else {
          query = query.is("owner_user_id", null);
        }

        const result = await query;
        const rows = (result.data || []) as ViewRow[];
        return Promise.all(rows.map((r) => hydrate(r)));
      })(),
      [] as LoadedView[],
    );
  },
);

/**
 * Pick the default view for (tenant, object). Per-user default wins over
 * workspace-shared. Returns null when no view exists — caller falls back
 * to URL-param + legacy behavior.
 */
export const loadDefaultView = cache(
  async (tenantId: string, objectMetadataId: string, userId?: string | null): Promise<LoadedView | null> => {
    const views = await loadViewsForObject(tenantId, objectMetadataId, userId);
    if (views.length === 0) return null;
    const userDefault = userId ? views.find((v) => v.owner_user_id === userId && v.is_default) : null;
    if (userDefault) return userDefault;
    const sharedDefault = views.find((v) => v.owner_user_id === null && v.is_default);
    return sharedDefault ?? null;
  },
);

/**
 * Translate a view's filters + sorts into a chain of `.filter()` /
 * `.order()` calls applied over a Supabase query. Field names map to
 * JSONB paths in tenant_records.data (e.g., field "first_name" → JSONB
 * arrow `data->>'first_name'`).
 *
 * Pure-function so it's unit-testable. Caller passes the query, this
 * returns the chained query.
 */
export function applyViewToQuery<Q extends {
  filter: (col: string, op: string, val: unknown) => Q;
  order: (col: string, opts: { ascending: boolean }) => Q;
}>(query: Q, view: LoadedView): Q {
  let q = query;

  for (const f of view.filters) {
    const col = `data->>${JSON.stringify(f.field_name)}`;
    const supabaseOp = mapOperator(f.operator);
    if (supabaseOp === null) continue; // unsupported in this dialect; skip
    q = q.filter(col, supabaseOp, f.value);
  }

  for (const s of view.sorts) {
    const col = `data->>${JSON.stringify(s.field_name)}`;
    q = q.order(col, { ascending: s.direction === "ASC" });
  }

  return q;
}

/**
 * 10 view-filter operators → Supabase filter() ops. Pure function for the
 * test harness. `null` return = the dialect can't express it; caller
 * skips that filter.
 */
export function mapOperator(op: ViewFilterOperator): string | null {
  switch (op) {
    case "eq":
      return "eq";
    case "neq":
      return "neq";
    case "gt":
      return "gt";
    case "lt":
      return "lt";
    case "gte":
      return "gte";
    case "lte":
      return "lte";
    case "contains":
      return "ilike";
    case "starts_with":
      return "ilike";
    case "in":
      return "in";
    case "is_null":
      return "is";
  }
}
