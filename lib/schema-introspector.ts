/**
 * Schema Introspector — read-side resolution of "what fields does this
 * tenant's entity-type have?" V6.9.0 substrate.
 *
 * Background: pre-V6.9, tenant data shape was declared inline in
 * `manifest.data_model[]` (JSON only). Migration 070 (V6.9.0) adds
 * `object_metadata` + `field_metadata` tables as the new source of truth.
 *
 * Resolution order (forward-only, no backfill required):
 *   1. object_metadata row matching (tenant_id, slug=entity_type) — DB wins.
 *   2. manifest.data_model[] entry matching name=entity_type — legacy fallback.
 *   3. null — caller decides whether to throw or render an empty form.
 *
 * The fallback path keeps every pre-070 tenant working unchanged. New entity
 * types added through the AI manifest editor (V6.9.4) write DB rows; old
 * inline entities keep loading from the manifest until/unless an operator
 * migrates them.
 *
 * This module is the FK target for V6.9.1 saved-view rows
 * (views.object_metadata_id → object_metadata.id), so every introspected
 * entity comes back with an `id` whenever it's DB-backed. Fallback entries
 * have id=null — saved views aren't supported against legacy inline-only
 * entities until they're migrated.
 */

import { cache } from "react";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getManifest } from "@/lib/manifest/loader";
import type { ManifestEntityField } from "@/lib/manifest/schema";

/**
 * 16 typed values matching the field_metadata_type Postgres enum.
 * Superset of ManifestEntityField["type"] (which has 7 inline types).
 */
export type FieldType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "enum"
  | "json"
  | "currency"
  | "address"
  | "rich_text"
  | "link"
  | "multi_select"
  | "rating"
  | "phone"
  | "email"
  | "relation";

export type IntrospectedField = {
  /** field_metadata.id when DB-backed; null when inferred from manifest. */
  id: string | null;
  name: string;
  label: string;
  type: FieldType;
  is_required: boolean;
  is_unique: boolean;
  is_system: boolean;
  is_active: boolean;
  position: number;
  default_value: unknown;
  options: Record<string, unknown>;
  description?: string;
  /** "db" when row exists in field_metadata; "manifest" when from data_model[]. */
  source: "db" | "manifest";
};

export type IntrospectedObject = {
  /** object_metadata.id when DB-backed; null when inferred from manifest. */
  id: string | null;
  tenant_id: string | null;
  slug: string;
  label: string;
  label_plural: string;
  icon?: string;
  description?: string;
  is_system: boolean;
  is_active: boolean;
  fields: IntrospectedField[];
  source: "db" | "manifest";
};

type ObjectRow = {
  id: string;
  tenant_id: string;
  slug: string;
  label: string;
  label_plural: string;
  icon: string | null;
  description: string | null;
  is_system: boolean;
  is_active: boolean;
};

type FieldRow = {
  id: string;
  object_id: string;
  name: string;
  label: string;
  type: FieldType;
  is_required: boolean;
  is_unique: boolean;
  is_system: boolean;
  is_active: boolean;
  position: number;
  default_value: unknown;
  options: Record<string, unknown> | null;
  description: string | null;
};

/**
 * 7 inline types → 16-type enum. Lossless: every inline value has an exact
 * counterpart. `string` is the only rename (becomes `text`).
 */
function mapInlineFieldType(inline: ManifestEntityField["type"]): FieldType {
  switch (inline) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "enum":
      return "enum";
    case "json":
      return "json";
  }
}

function manifestFieldToIntrospected(
  field: ManifestEntityField,
  position: number,
): IntrospectedField {
  const options: Record<string, unknown> = {};
  if (field.enum_values) options.enum_values = field.enum_values;
  return {
    id: null,
    name: field.name,
    label: field.name,
    type: mapInlineFieldType(field.type),
    is_required: Boolean(field.required),
    is_unique: false,
    is_system: false,
    is_active: true,
    position,
    default_value: field.default ?? null,
    options,
    source: "manifest",
  };
}

async function loadObjectFromDb(
  tenantId: string,
  slug: string,
): Promise<IntrospectedObject | null> {
  return safe(
    "schema-introspector.loadObjectFromDb",
    (async () => {
      const db = getServiceSupabase();
      const objectResult = await db
        .from("object_metadata")
        .select("id, tenant_id, slug, label, label_plural, icon, description, is_system, is_active")
        .eq("tenant_id", tenantId)
        .eq("slug", slug)
        .eq("is_active", true)
        .maybeSingle();
      const object = (objectResult.data || null) as ObjectRow | null;
      if (!object) return null;

      const fieldsResult = await db
        .from("field_metadata")
        .select(
          "id, object_id, name, label, type, is_required, is_unique, is_system, is_active, position, default_value, options, description",
        )
        .eq("object_id", object.id)
        .eq("is_active", true)
        .order("position", { ascending: true });
      const fields = (fieldsResult.data || []) as FieldRow[];

      return {
        id: object.id,
        tenant_id: object.tenant_id,
        slug: object.slug,
        label: object.label,
        label_plural: object.label_plural,
        icon: object.icon ?? undefined,
        description: object.description ?? undefined,
        is_system: object.is_system,
        is_active: object.is_active,
        fields: fields.map((f) => ({
          id: f.id,
          name: f.name,
          label: f.label,
          type: f.type,
          is_required: f.is_required,
          is_unique: f.is_unique,
          is_system: f.is_system,
          is_active: f.is_active,
          position: f.position,
          default_value: f.default_value,
          options: f.options ?? {},
          description: f.description ?? undefined,
          source: "db" as const,
        })),
        source: "db",
      };
    })(),
    null as IntrospectedObject | null,
  );
}

async function loadObjectFromManifest(
  tenantSlug: string,
  entityType: string,
): Promise<IntrospectedObject | null> {
  const manifest = await getManifest(tenantSlug);
  const entity = manifest.data_model?.find((e) => e.name === entityType);
  if (!entity) return null;
  return {
    id: null,
    tenant_id: null,
    slug: entity.name,
    label: entity.label,
    label_plural: entity.label,
    is_system: false,
    is_active: true,
    fields: entity.fields.map((f, idx) => manifestFieldToIntrospected(f, idx)),
    source: "manifest",
  };
}

/**
 * Resolve an entity-type to its field schema, preferring DB rows over manifest
 * inline declarations. Memoized per-request via React's `cache`.
 *
 * @param tenantId   UUID of the tenant (object_metadata.tenant_id)
 * @param tenantSlug Manifest slug (for the data_model[] fallback path)
 * @param entityType Entity name, e.g. "lead", "application", "lender"
 */
export const inferRecordFields = cache(
  async (
    tenantId: string,
    tenantSlug: string,
    entityType: string,
  ): Promise<IntrospectedObject | null> => {
    const fromDb = await loadObjectFromDb(tenantId, entityType);
    if (fromDb) return fromDb;
    return loadObjectFromManifest(tenantSlug, entityType);
  },
);

/**
 * List all DB-backed object_metadata for a tenant. Does not merge in
 * manifest.data_model[] (use listAllObjects for the merged view).
 */
export const loadObjectMetadata = cache(
  async (tenantId: string): Promise<IntrospectedObject[]> => {
    return safe(
      "schema-introspector.loadObjectMetadata",
      (async () => {
        const db = getServiceSupabase();
        const result = await db
          .from("object_metadata")
          .select(
            "id, tenant_id, slug, label, label_plural, icon, description, is_system, is_active",
          )
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .order("slug", { ascending: true });
        const rows = (result.data || []) as ObjectRow[];
        if (rows.length === 0) return [];

        const fieldResult = await db
          .from("field_metadata")
          .select(
            "id, object_id, name, label, type, is_required, is_unique, is_system, is_active, position, default_value, options, description",
          )
          .in("object_id", rows.map((r) => r.id))
          .eq("is_active", true)
          .order("position", { ascending: true });
        const allFields = (fieldResult.data || []) as FieldRow[];

        const fieldsByObject = new Map<string, FieldRow[]>();
        for (const f of allFields) {
          const list = fieldsByObject.get(f.object_id);
          if (list) list.push(f);
          else fieldsByObject.set(f.object_id, [f]);
        }

        return rows.map((object) => ({
          id: object.id,
          tenant_id: object.tenant_id,
          slug: object.slug,
          label: object.label,
          label_plural: object.label_plural,
          icon: object.icon ?? undefined,
          description: object.description ?? undefined,
          is_system: object.is_system,
          is_active: object.is_active,
          fields: (fieldsByObject.get(object.id) || []).map((f) => ({
            id: f.id,
            name: f.name,
            label: f.label,
            type: f.type,
            is_required: f.is_required,
            is_unique: f.is_unique,
            is_system: f.is_system,
            is_active: f.is_active,
            position: f.position,
            default_value: f.default_value,
            options: f.options ?? {},
            description: f.description ?? undefined,
            source: "db" as const,
          })),
          source: "db" as const,
        }));
      })(),
      [] as IntrospectedObject[],
    );
  },
);

/**
 * Load field_metadata rows for a single object. Used by the AI manifest
 * editor (V6.9.4) when previewing field edits before commit.
 */
export const loadFieldMetadata = cache(
  async (objectId: string): Promise<IntrospectedField[]> => {
    return safe(
      "schema-introspector.loadFieldMetadata",
      (async () => {
        const db = getServiceSupabase();
        const result = await db
          .from("field_metadata")
          .select(
            "id, object_id, name, label, type, is_required, is_unique, is_system, is_active, position, default_value, options, description",
          )
          .eq("object_id", objectId)
          .eq("is_active", true)
          .order("position", { ascending: true });
        const rows = (result.data || []) as FieldRow[];
        return rows.map((f) => ({
          id: f.id,
          name: f.name,
          label: f.label,
          type: f.type,
          is_required: f.is_required,
          is_unique: f.is_unique,
          is_system: f.is_system,
          is_active: f.is_active,
          position: f.position,
          default_value: f.default_value,
          options: f.options ?? {},
          description: f.description ?? undefined,
          source: "db" as const,
        }));
      })(),
      [] as IntrospectedField[],
    );
  },
);

export const __test__ = { mapInlineFieldType, manifestFieldToIntrospected };
