/**
 * POST /api/tenant/agents/toggle — owner-only mutation of the tenant's
 * manifest.agents array.
 *
 * Body: { action: "add" | "enable" | "disable" | "remove", slug: string }
 *
 * Rules:
 *   - Caller MUST be signed in AND be the owner of the tenant
 *     (user_profiles.is_owner = true for their tenant_id).
 *   - "add"     — slug must NOT already exist on the manifest. Appends
 *                 a new agent binding with enabled=true, core=false.
 *                 Only slugs in AGENT_REGISTRY may be added (prevents
 *                 garbage strings from polluting the manifest).
 *   - "enable"  — flips enabled=true on an existing binding.
 *   - "disable" — flips enabled=false on an existing binding. Refused
 *                 for core agents (core=true cannot be disabled).
 *   - "remove"  — drops the binding entirely. Refused for core agents.
 *
 * Returns the updated agents array on success so the client can
 * re-render without a follow-up GET.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { AGENT_REGISTRY, getAgentInfo, resolveAgentKey } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_ACTIONS = new Set(["add", "enable", "disable", "remove"]);

type ManifestAgent = {
  slug: string;
  display_name: string;
  enabled: boolean;
  primary?: boolean;
  core?: boolean;
  model_override?: string;
  prompt_overlay?: string;
};

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: string; slug?: string };
  try {
    body = (await req.json()) as { action?: string; slug?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const action = (body.action || "").trim();
  const slug = resolveAgentKey((body.slug || "").trim().toLowerCase());
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }
  if (!slug) {
    return NextResponse.json({ ok: false, error: "missing_slug" }, { status: 400 });
  }

  const db = getServiceSupabase();
  // Owner check — only the workspace owner can mutate the agent lineup.
  const profile = await db
    .from("user_profiles")
    .select("tenant_id, is_owner")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null; is_owner?: boolean } | null)?.tenant_id;
  const isOwner = (profile.data as { is_owner?: boolean } | null)?.is_owner === true;
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  if (!isOwner) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only the workspace owner can manage agents." },
      { status: 403 },
    );
  }

  // Resolve the tenant_manifests row. For tenants whose manifest still
  // lives in the code seed (no DB row yet), copy the seed into DB so
  // we have something to mutate. Otherwise modify in place.
  const tenantRow = await db
    .from("tenants")
    .select("slug, custom_fields")
    .eq("id", tenantId)
    .maybeSingle();
  const tenantSlug = resolveClientProfileSlug({
    slug: (tenantRow.data as { slug?: string } | null)?.slug || "",
    custom_fields: (tenantRow.data as { custom_fields?: Record<string, unknown> } | null)?.custom_fields || {},
  });
  if (!tenantSlug) {
    return NextResponse.json(
      { ok: false, error: "no_tenant_slug" },
      { status: 400 },
    );
  }

  const existingRow = await db
    .from("tenant_manifests")
    .select("manifest")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  let manifest = (existingRow.data as { manifest?: Record<string, unknown> } | null)?.manifest;
  if (!manifest) {
    // Seed-only manifest — load and persist a DB copy so we can mutate.
    const seed = await getTenantManifestForUser(tenantId);
    if (!seed) {
      return NextResponse.json(
        { ok: false, error: "no_manifest", message: "No manifest found for this tenant." },
        { status: 400 },
      );
    }
    manifest = seed as unknown as Record<string, unknown>;
  }

  const agents: ManifestAgent[] = Array.isArray((manifest as { agents?: unknown }).agents)
    ? ((manifest as { agents: ManifestAgent[] }).agents as ManifestAgent[]).map((a) => ({ ...a }))
    : [];

  const idx = agents.findIndex((a) => a.slug.toLowerCase() === slug);

  // Apply the action.
  if (action === "add") {
    if (idx >= 0) {
      return NextResponse.json(
        { ok: false, error: "already_in_workspace" },
        { status: 409 },
      );
    }
    if (!AGENT_REGISTRY[slug]) {
      return NextResponse.json(
        { ok: false, error: "unknown_agent", message: `${slug} is not a registered agent.` },
        { status: 400 },
      );
    }
    const info = getAgentInfo(slug);
    agents.push({
      slug,
      display_name: info.label,
      enabled: true,
      core: false,
    });
  } else {
    if (idx < 0) {
      return NextResponse.json({ ok: false, error: "not_in_workspace" }, { status: 404 });
    }
    const current = agents[idx];
    if (action === "enable") {
      current.enabled = true;
    } else if (action === "disable") {
      if (current.core === true) {
        return NextResponse.json(
          { ok: false, error: "core_locked", message: "Core agents cannot be disabled." },
          { status: 409 },
        );
      }
      current.enabled = false;
    } else if (action === "remove") {
      if (current.core === true) {
        return NextResponse.json(
          { ok: false, error: "core_locked", message: "Core agents cannot be removed." },
          { status: 409 },
        );
      }
      agents.splice(idx, 1);
    }
  }

  const newManifest = { ...(manifest as Record<string, unknown>), agents };

  // Upsert the manifest row. Existing rows get UPDATE; seed-only
  // tenants get INSERT so subsequent mutations have a row to hit.
  const upsert = await db
    .from("tenant_manifests")
    .upsert(
      {
        tenant_id: tenantId,
        manifest: newManifest,
      },
      { onConflict: "tenant_id" },
    )
    .select("manifest")
    .single();
  if (upsert.error) {
    return NextResponse.json(
      { ok: false, error: "manifest_write_failed", message: upsert.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    agents,
    message:
      action === "add"
        ? `Added ${getAgentInfo(slug).label}`
        : action === "remove"
          ? `Removed ${getAgentInfo(slug).label}`
          : action === "enable"
            ? `Enabled ${getAgentInfo(slug).label}`
            : `Disabled ${getAgentInfo(slug).label}`,
  });
}
