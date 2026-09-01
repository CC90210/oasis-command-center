/**
 * POST /api/agent-config/test-connection
 *
 * One-shot provider-key validation. Two modes, single endpoint:
 *
 * 1. Test the SAVED key (default — body { provider }):
 *      Reads the encrypted key from agent_model_config (tenant-wide row
 *      first, per-user override second), decrypts, pings the provider's
 *      `/models`-equivalent endpoint, reports latency or error.
 *
 * 2. Test a PROPOSED key before saving (body { provider, api_key }):
 *      Skips the DB lookup and pings with the supplied key directly so
 *      the AgentConfigEditor's "Test connection" button can validate
 *      a key the operator just pasted but hasn't saved.
 *
 * Auth: session — both modes require a logged-in operator. Mode #2 is
 * NOT a public oracle for credential stuffing; the rate limit + session
 * gate keep it safe.
 *
 * Provider probes (all light, all idempotent, all auth-only):
 *   - OpenRouter: GET https://openrouter.ai/api/v1/models
 *   - Anthropic:  GET https://api.anthropic.com/v1/models
 *   - OpenAI:     GET https://api.openai.com/v1/models
 *   - Gemini:     GET https://generativelanguage.googleapis.com/v1beta/models
 *   - Ollama:     GET <user-supplied URL>/api/tags  (the "key" IS the URL)
 *
 * Response shape (unified for both modes):
 *   { ok: true,  status: "ok",    provider, latency_ms, provider_response_ms }
 *   { ok: false, status: "error", provider, message, code? }
 *
 * Codes (when ok=false):
 *   "401" "403" "429" "5xx" → provider HTTP status
 *   "timeout"               → no response in 15s
 *   "network"               → fetch threw before HTTP
 *   "no_key_on_file"        → mode 1, no saved key for provider
 *   "decrypt_failed"        → mode 1, decryptField threw
 *   "config"                → provider not in PROBE_URL map
 *   "invalid_provider"      → body.provider invalid
 *
 * Replaces the standalone /api/agent-config/test-key endpoint (deleted
 * 2026-05-23) — that was a duplicate built before realizing this one
 * existed. AgentConfigEditor now calls this with `{provider, api_key}`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { decryptField } from "@/lib/field-encryption";
import { resolveSessionContext } from "@/lib/api-auth";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";
import type { Provider } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter", "ollama"];
const TIMEOUT_MS = 15_000;

type PingResult =
  | { ok: true; latency_ms: number }
  | { ok: false; message: string; code?: string };

function buildUrl(provider: Provider, key: string): string {
  if (provider === "openrouter") return "https://openrouter.ai/api/v1/models";
  if (provider === "anthropic") return "https://api.anthropic.com/v1/models";
  if (provider === "openai") return "https://api.openai.com/v1/models";
  if (provider === "google") {
    return `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`;
  }
  if (provider === "ollama") {
    // Operator pastes a URL in the api_key field; accept both bare
    // host:port and host:port/v1 forms and append /api/tags for the
    // unversioned probe.
    const trimmed = key.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${trimmed}/api/tags`;
  }
  return "";
}

function buildHeaders(provider: Provider, key: string): Record<string, string> {
  if (provider === "anthropic") {
    return { "x-api-key": key, "anthropic-version": "2023-06-01", accept: "application/json" };
  }
  if (provider === "google" || provider === "ollama") {
    return { accept: "application/json" };
  }
  return { authorization: `Bearer ${key}`, accept: "application/json" };
}

function inferShapeHint(provider: Provider, key: string): string {
  // Quick paste-error detection. Returns a single sentence appended to
  // a 401 message when the key doesn't match the provider's shape.
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    return "Anthropic keys start with `sk-ant-`.";
  }
  if (provider === "openai" && !(key.startsWith("sk-") || key.startsWith("sk-proj-"))) {
    return "OpenAI keys start with `sk-` or `sk-proj-`.";
  }
  if (provider === "openrouter" && !key.startsWith("sk-or-")) {
    return "OpenRouter keys start with `sk-or-`.";
  }
  if (provider === "google" && !key.startsWith("AIza")) {
    return "Google AI Studio keys start with `AIza`.";
  }
  if (provider === "ollama" && !key.startsWith("http")) {
    return "Ollama field takes a URL like `http://localhost:11434`, not an API key.";
  }
  return "";
}

function classify(provider: Provider, status: number, body: string, providedKey: string): { code: string; message: string } {
  if (status === 401) {
    const hint = inferShapeHint(provider, providedKey);
    const base = "Provider rejected the key (401). Double-check you copied it correctly.";
    return { code: "401", message: hint ? `${base} ${hint}` : base };
  }
  if (status === 403) {
    return { code: "403", message: "Provider accepted the key but says it isn't authorized for this endpoint. Verify your account has API access enabled." };
  }
  if (status === 429) {
    return { code: "429", message: "Provider rate-limited the test call. Wait a minute and try again — the key may still be valid." };
  }
  if (status >= 500) {
    return { code: "5xx", message: `Provider returned ${status}. Often transient — try again in a minute.` };
  }
  // Best-effort surface the provider's own error body
  let detail = "";
  try {
    const j = JSON.parse(body);
    detail =
      (j?.error?.message as string) ||
      (j?.message as string) ||
      (typeof j?.error === "string" ? j.error : "") ||
      "";
  } catch {
    /* not JSON */
  }
  return {
    code: String(status),
    message: detail ? `${detail} (HTTP ${status})` : `Probe failed with HTTP ${status}.`,
  };
}

async function pingProvider(provider: Provider, key: string): Promise<PingResult> {
  const url = buildUrl(provider, key);
  if (!url) return { ok: false, code: "config", message: `No probe URL configured for ${provider}.` };
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers: buildHeaders(provider, key), signal: ctl.signal });
    const latency = Date.now() - started;
    if (res.ok) return { ok: true, latency_ms: latency };
    const text = await res.text().catch(() => "");
    const { code, message } = classify(provider, res.status, text, key);
    return { ok: false, code, message };
  } catch (err) {
    const isAbort = (err as Error).name === "AbortError";
    return {
      ok: false,
      code: isAbort ? "timeout" : "network",
      message: isAbort
        ? `Provider didn't respond within ${TIMEOUT_MS / 1000}s.${provider === "ollama" ? " Is Ollama running and the URL reachable?" : ""}`
        : (err as Error).message || "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await resolveSessionContext();
  if (!ctx.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!(await canAccessSharedTenantResource(ctx))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { provider?: string; api_key?: string };
  try {
    body = (await req.json()) as { provider?: string; api_key?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const provider = String(body.provider || "") as Provider;
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ ok: false, error: `invalid_provider:${provider}`, code: "invalid_provider" }, { status: 400 });
  }

  // Mode 2: test the proposed key directly (before save). The api_key
  // field IS the value to test — skip the DB lookup entirely.
  const proposedKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (proposedKey) {
    const result = await pingProvider(provider, proposedKey);
    if (result.ok) {
      return NextResponse.json({
        ok: true,
        status: "ok",
        provider,
        latency_ms: result.latency_ms,
        provider_response_ms: result.latency_ms,
      });
    }
    return NextResponse.json({
      ok: false,
      status: "error",
      provider,
      message: result.message,
      code: result.code,
    });
  }

  // Mode 1: test the saved key. Tenant-wide row first, then per-user
  // override. Either has the same encrypted_api_key column shape; first
  // non-empty value wins.
  const db = getServiceSupabase();
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
        .eq("user_id", ctx.userId)
        .not("encrypted_api_key", "is", null)
        .limit(1)
        .maybeSingle();
  const encrypted =
    (tenantRow.data?.encrypted_api_key as string | null | undefined) ||
    (userRow?.data?.encrypted_api_key as string | null | undefined) ||
    null;
  if (!encrypted) {
    return NextResponse.json(
      { ok: false, status: "error", provider, code: "no_key_on_file", message: "No API key on file for this provider." },
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
        code: "decrypt_failed",
        message: `Stored key couldn't be decrypted (${(err as Error).message}). Try Replace key.`,
      },
      { status: 500 },
    );
  }

  const result = await pingProvider(provider, plain);
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      status: "ok",
      provider,
      latency_ms: result.latency_ms,
      provider_response_ms: result.latency_ms,
    });
  }
  return NextResponse.json({
    ok: false,
    status: "error",
    provider,
    message: result.message,
    code: result.code,
  });
}
