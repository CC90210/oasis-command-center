/**
 * POST /api/agent-config/test-connection
 *
 * Pings the provider's lightweight `list models` endpoint using the
 * key the tenant already has on file. Returns latency on success or
 * the provider's error message on failure — gives the operator a
 * one-click "is this still working?" check on the Settings card
 * without forcing them to send a real chat turn.
 *
 * Body shape:
 *   { provider: "anthropic" | "openai" | "google" | "openrouter" }
 *
 * Response shape:
 *   { ok: true,  status: "ok",    provider, latency_ms }
 *   { ok: false, status: "error", provider, message }
 *
 * Endpoints used (all light, all idempotent, all auth-only):
 *   - OpenRouter: GET https://openrouter.ai/api/v1/models
 *   - Anthropic:  GET https://api.anthropic.com/v1/models
 *   - OpenAI:     GET https://api.openai.com/v1/models
 *   - Gemini:     GET https://generativelanguage.googleapis.com/v1beta/models
 *
 * Key lookup priority: tenant-wide row (user_id IS NULL) first, then
 * the operator's per-user row. Picks the first non-empty key found so
 * the test works whether the operator wired up a personal override or
 * the workspace default.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { decryptField } from "@/lib/field-encryption";
import { getSessionContext } from "@/lib/team";
import type { Provider } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

type PingResult =
  | { ok: true; latency_ms: number }
  | { ok: false; message: string };

async function pingProvider(provider: Provider, key: string): Promise<PingResult> {
  const started = Date.now();
  try {
    let url: string;
    const headers: Record<string, string> = {};
    if (provider === "openrouter") {
      url = "https://openrouter.ai/api/v1/models";
      headers["Authorization"] = `Bearer ${key}`;
    } else if (provider === "anthropic") {
      url = "https://api.anthropic.com/v1/models";
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "openai") {
      url = "https://api.openai.com/v1/models";
      headers["Authorization"] = `Bearer ${key}`;
    } else if (provider === "google") {
      // Gemini lists models with the API key as a URL parameter; no auth header.
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    } else {
      return { ok: false, message: `unknown_provider:${provider}` };
    }

    // 7s budget — every endpoint above is single-region, so anything slower
    // than that is treated as unavailable from the operator's POV.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    const latency = Date.now() - started;
    if (res.ok) return { ok: true, latency_ms: latency };

    // Surface the provider's error body when present — operators are
    // far more likely to fix "Invalid API key" than "HTTP 401".
    let detail = "";
    try {
      const j = await res.json();
      detail =
        (j?.error?.message as string) ||
        (j?.message as string) ||
        (typeof j?.error === "string" ? j.error : "") ||
        "";
    } catch {
      // Body wasn't JSON; fall through to the status-code message.
    }
    return {
      ok: false,
      message: detail
        ? `${detail} (HTTP ${res.status})`
        : `HTTP ${res.status} ${res.statusText || ""}`.trim(),
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, message: "Provider didn't respond within 15 seconds." };
    }
    return { ok: false, message: (err as Error).message || "network_error" };
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { provider?: string };
  try {
    body = (await req.json()) as { provider?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const provider = String(body.provider || "") as Provider;
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ ok: false, error: `invalid_provider:${provider}` }, { status: 400 });
  }

  const db = getServiceSupabase();
  // Tenant-wide first, then per-user override. Either has the same
  // encrypted_api_key column shape; first row with a non-empty value wins.
  const tenantRow = await db
    .from("agent_model_config")
    .select("encrypted_api_key")
    .eq("tenant_id", ctx.tenantId)
    .eq("provider", provider)
    .is("user_id", null)
    .not("encrypted_api_key", "is", null)
    .limit(1)
    .maybeSingle();
  const userRow = tenantRow.data?.encrypted_api_key
    ? null
    : await db
        .from("agent_model_config")
        .select("encrypted_api_key")
        .eq("tenant_id", ctx.tenantId)
        .eq("provider", provider)
        .eq("user_id", ctx.authUserId)
        .not("encrypted_api_key", "is", null)
        .limit(1)
        .maybeSingle();
  const encrypted =
    (tenantRow.data?.encrypted_api_key as string | null | undefined) ||
    (userRow?.data?.encrypted_api_key as string | null | undefined) ||
    null;
  if (!encrypted) {
    return NextResponse.json(
      { ok: false, status: "error", provider, message: "No API key on file for this provider." },
      { status: 404 },
    );
  }

  let plain: string;
  try {
    plain = decryptField(encrypted);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        provider,
        message: `Stored key couldn't be decrypted (${(err as Error).message}). Try Replace key.`,
      },
      { status: 500 },
    );
  }

  const result = await pingProvider(provider, plain);
  if (result.ok) {
    return NextResponse.json({ ok: true, status: "ok", provider, latency_ms: result.latency_ms });
  }
  return NextResponse.json({ ok: false, status: "error", provider, message: result.message });
}
