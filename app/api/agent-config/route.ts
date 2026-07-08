/**
 * GET  /api/agent-config              — list this tenant's per-agent configs
 *                                        (api key NEVER returned, only `has_key: true|false`)
 * POST /api/agent-config              — upsert config + encrypted key
 *
 * POST body:
 *   {
 *     agent_key: "bravo" | ...,
 *     provider: "anthropic" | "openai" | "google",
 *     model: string,
 *     api_key?: string,                 // omit to leave existing key intact
 *     system_prompt_override?: string,
 *     enabled?: boolean
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthedSupabase, getServiceSupabase } from "@/lib/supabase-server";
import { isTenantChatAgent } from "@/lib/manifest/tenant-scope";
import { PROVIDER_MODELS } from "@/lib/providers";
import { encryptField } from "@/lib/field-encryption";
import { canManageTeam, getSessionContext } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function resolveTenant(): Promise<{
  tenantId: string | null;
  userId: string | null;
  canManageTenant: boolean;
}> {
  const ctx = await getSessionContext();
  if (!ctx) return { tenantId: null, userId: null, canManageTenant: false };
  return {
    tenantId: ctx.tenantId,
    userId: ctx.authUserId,
    canManageTenant: ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess),
  };
}

export async function GET(req: NextRequest) {
  const { tenantId, userId } = await resolveTenant();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  // ?scope=user returns the operator's personal overrides; default is
  // tenant-scope (backwards compatible with the prior contract).
  // Phase B of the master multi-tenant infra plan (2026-05-17).
  const scope = req.nextUrl.searchParams.get("scope") === "user" ? "user" : "tenant";
  const service = getServiceSupabase();
  let q = service
    .from("agent_model_config")
    .select("agent_key, provider, model, enabled, last_used_at, encrypted_api_key, system_prompt_override, display_name_override")
    .eq("tenant_id", tenantId);
  if (scope === "user") {
    if (!userId) return NextResponse.json({ ok: false, error: "no_user" }, { status: 401 });
    q = q.eq("user_id", userId);
  } else {
    q = q.is("user_id", null);
  }
  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const configs = (data || []).map((row) => ({
    agent_key: row.agent_key,
    provider: row.provider,
    model: row.model,
    enabled: row.enabled,
    last_used_at: row.last_used_at,
    has_key: !!row.encrypted_api_key,
    has_override: !!row.system_prompt_override,
    // Surface the actual value (not just a boolean) so the Settings UI
    // can hydrate the text input on render — display name overrides are
    // intentionally non-secret. Only present on user-scope reads since
    // display_name_override never lives on tenant default rows.
    display_name_override:
      scope === "user" ? ((row.display_name_override as string | null) || null) : null,
  }));
  return NextResponse.json({ ok: true, scope, configs });
}

export async function POST(req: NextRequest) {
  const { tenantId, userId, canManageTenant } = await resolveTenant();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const agentKey = String(body?.agent_key || "").toLowerCase();
  if (!(await isTenantChatAgent(tenantId, agentKey))) {
    return NextResponse.json({ ok: false, error: `invalid_agent:${agentKey}` }, { status: 400 });
  }
  const provider = String(body?.provider || "");
  if (!Object.keys(PROVIDER_MODELS).includes(provider)) {
    return NextResponse.json({ ok: false, error: `invalid_provider:${provider}` }, { status: 400 });
  }
  const model = String(body?.model || "").trim();
  if (!model) return NextResponse.json({ ok: false, error: "missing_model" }, { status: 400 });

  const apiKeyPlain: string | undefined =
    typeof body?.api_key === "string" && body.api_key.trim() ? body.api_key.trim() : undefined;
  const overrideRaw: string | undefined =
    typeof body?.system_prompt_override === "string" ? body.system_prompt_override : undefined;
  // display_name_override is per-user only; tenant-scope writes ignore it
  // (canonical names stay on the tenant default row). Same parsing shape
  // as overrideRaw: empty/whitespace clears, non-empty stores.
  const displayNameRaw: string | undefined =
    typeof body?.display_name_override === "string" ? body.display_name_override : undefined;
  const enabled = body?.enabled === false ? false : true;

  const service = getServiceSupabase();

  // Encrypt key Node-side if a new one was supplied
  let encryptedKey: string | undefined;
  if (apiKeyPlain) {
    try {
      encryptedKey = encryptField(apiKeyPlain);
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "encrypt_failed" },
        { status: 500 }
      );
    }
  }

  // Scope: "user" writes (tenant_id, user_id, agent_key); "tenant" (default)
  // writes (tenant_id, NULL, agent_key). Phase B of master multi-tenant
  // infra plan (2026-05-17).
  const scope = body?.scope === "user" ? "user" : "tenant";
  if (scope === "tenant" && !canManageTenant) {
    return NextResponse.json({ ok: false, error: "admin_required" }, { status: 403 });
  }
  if (scope === "user" && !userId) {
    return NextResponse.json({ ok: false, error: "no_user" }, { status: 401 });
  }
  const effectiveUserId = scope === "user" ? userId : null;

  // Upsert
  let existingQ = service
    .from("agent_model_config")
    .select("id, encrypted_api_key")
    .eq("tenant_id", tenantId)
    .eq("agent_key", agentKey);
  existingQ = effectiveUserId
    ? existingQ.eq("user_id", effectiveUserId)
    : existingQ.is("user_id", null);
  const { data: existing } = await existingQ.maybeSingle();
  if (scope === "user" && !encryptedKey && !existing?.encrypted_api_key) {
    return NextResponse.json(
      {
        ok: false,
        error: "personal_key_required",
        message: "Personal agent overrides need an API key. Clear the override to use the team fallback.",
      },
      { status: 400 },
    );
  }

  const payload: Record<string, unknown> = {
    tenant_id: tenantId,
    user_id: effectiveUserId,
    agent_key: agentKey,
    provider,
    model,
    enabled,
  };
  if (encryptedKey !== undefined) payload.encrypted_api_key = encryptedKey;
  if (overrideRaw !== undefined) {
    payload.system_prompt_override = overrideRaw.trim().length ? overrideRaw : null;
  }
  // display_name_override only stamps on user-scope rows. Tenant defaults
  // keep the canonical name so per-user renames can't leak across the team.
  if (displayNameRaw !== undefined && scope === "user") {
    payload.display_name_override = displayNameRaw.trim().length ? displayNameRaw.trim() : null;
  }

  if (existing) {
    const { error } = await service
      .from("agent_model_config")
      .update(payload)
      .eq("id", existing.id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  } else {
    const { error } = await service.from("agent_model_config").insert(payload);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Audit-log (Phase D). Best-effort; never bubble up to the operator.
  try {
    const authed = await getAuthedSupabase();
    await authed.rpc("log_tenant_event", {
      p_tenant_id: tenantId,
      p_action_type: scope === "user" ? "agent_config.user_update" : "agent_config.tenant_update",
      p_target_table: "agent_model_config",
      p_target_id: `${tenantId}:${effectiveUserId || "tenant"}:${agentKey}`,
      p_after: { provider, model, enabled, has_key: !!encryptedKey, has_override: overrideRaw !== undefined },
    });
  } catch {
    // audit-log soft-fail
  }

  return NextResponse.json({ ok: true, scope });
}

export async function DELETE(req: NextRequest) {
  const { tenantId, userId, canManageTenant } = await resolveTenant();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl;
  const scope = url.searchParams.get("scope") === "user" ? "user" : "tenant";
  const agentKey = (url.searchParams.get("agent_key") || "").toLowerCase();
  if (!(await isTenantChatAgent(tenantId, agentKey))) {
    return NextResponse.json({ ok: false, error: `invalid_agent:${agentKey}` }, { status: 400 });
  }
  if (scope === "user" && !userId) {
    return NextResponse.json({ ok: false, error: "no_user" }, { status: 401 });
  }
  if (scope === "tenant" && !canManageTenant) {
    return NextResponse.json({ ok: false, error: "admin_required" }, { status: 403 });
  }
  const service = getServiceSupabase();
  let q = service
    .from("agent_model_config")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("agent_key", agentKey);
  q = scope === "user" ? q.eq("user_id", userId!) : q.is("user_id", null);
  const { error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Audit-log the delete (Phase D).
  try {
    const authed = await getAuthedSupabase();
    await authed.rpc("log_tenant_event", {
      p_tenant_id: tenantId,
      p_action_type: scope === "user" ? "agent_config.user_clear" : "agent_config.tenant_clear",
      p_target_table: "agent_model_config",
      p_target_id: `${tenantId}:${scope === "user" ? userId : "tenant"}:${agentKey}`,
    });
  } catch {
    // audit-log soft-fail
  }
  return NextResponse.json({ ok: true });
}
