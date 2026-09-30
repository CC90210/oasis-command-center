/**
 * GET /api/usage?agent=<key>
 *
 * Two answers for the chat header:
 *   - which key this agent would use: `key_source` "saved" (the agent's own
 *     encrypted key) or "platform" (the OASIS platform key, for the verified
 *     platform operator only, the same rule lib/chat-auth.ts applies). No key
 *     at all is a 412 no_api_key, and the chat then says it is not ready
 *     instead of claiming a "platform default" (2026-09-30);
 *   - for OpenRouter, the key's usage from /api/v1/auth/key, so the header can
 *     show "$3.42 / $10 used". Anthropic, OpenAI and Google have no per-key
 *     usage endpoint: `supported: false`.
 *
 * The platform fallback used to be PLATFORM_DEFAULT_OPENROUTER_API_KEY for ANY
 * signed-in user with no key of their own, which read OASIS's OpenRouter
 * spend to every workspace. It is now operatorPlatformFallback(), behind the
 * verified-operator check. Read-only; no mutations possible here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { decryptField } from "@/lib/field-encryption";
import { getAgentModelForUser } from "@/lib/agent-resolver";
import { operatorPlatformFallback } from "@/lib/operator-credentials";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error, key_source: null }, { status });
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return bad(401, "unauthorized");

  const agentKey = (new URL(req.url).searchParams.get("agent") || "").toLowerCase();
  if (!agentKey) return bad(400, "agent param required");

  const db = getServiceSupabase();
  const profileR = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (profileR.error) {
    console.error("[api.usage.profile]", profileR.error.message);
    return bad(503, "profile_lookup_failed");
  }
  const tenantId = (profileR.data?.tenant_id as string | null) || null;
  if (!tenantId) return bad(403, "no_tenant");

  const cfg = await getAgentModelForUser({ tenantId, userId: user.id, agentKey });

  let provider: string | null = null;
  let apiKey: string | null = null;
  let keySource: "saved" | "platform" | null = null;

  if (cfg?.encrypted_api_key) {
    try {
      apiKey = decryptField(cfg.encrypted_api_key as string);
    } catch (err) {
      console.error("[api.usage.decrypt]", err instanceof Error ? err.message : err);
      return bad(500, "key_decrypt_failed");
    }
    provider = cfg.provider || "openrouter";
    keySource = "saved";
  } else {
    const isOperator = await isPlatformOperatorForAuthUser(user.id, user.email);
    const fallback = isOperator ? operatorPlatformFallback() : null;
    if (fallback) {
      apiKey = fallback.apiKey;
      provider = fallback.provider;
      keySource = "platform";
    }
  }
  if (!apiKey || !keySource) return bad(412, "no_api_key");

  if (provider !== "openrouter") {
    // Anthropic / OpenAI / Google don't expose a clean per-key usage endpoint.
    return NextResponse.json({ ok: true, supported: false, provider, key_source: keySource });
  }

  try {
    const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: `openrouter_${r.status}`, key_source: keySource }, { status: r.status });
    const j = (await r.json()) as { data?: { usage?: number; limit?: number; is_free_tier?: boolean } };
    return NextResponse.json({
      ok: true,
      supported: true,
      provider: "openrouter",
      key_source: keySource,
      usage: j.data?.usage ?? 0,
      limit: j.data?.limit ?? null,
      is_free_tier: j.data?.is_free_tier ?? false,
    });
  } catch (e) {
    console.error("[api.usage.openrouter]", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "fetch_failed", key_source: keySource }, { status: 500 });
  }
}
