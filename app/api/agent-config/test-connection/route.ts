/**
 * POST /api/agent-config/test-connection
 *
 * One-shot provider-key validation. Two modes, single endpoint:
 *
 * 1. Test the SAVED key (default — body { provider }):
 *      Reads the encrypted key from agent_model_config (tenant-wide row
 *      first, per-user override second), decrypts, and runs the probe.
 *
 * 2. Test a PROPOSED key before saving (body { provider, api_key }):
 *      Skips the DB lookup and probes with the supplied key directly so
 *      the AgentConfigEditor's "Test connection" button can validate
 *      a key the operator just pasted but hasn't saved.
 *
 * Auth: session — both modes require a logged-in operator. Mode #2 is
 * NOT a public oracle for credential stuffing; the rate limit + session
 * gate keep it safe.
 *
 * THE PROBE IS A REAL ONE-TOKEN COMPLETION (lib/agents/provider-probe.ts),
 * never a model-list GET. Listing models spends nothing, so it proves nothing
 * about the account: OpenRouter answers GET /models with 200 for no key or a
 * bad key, and a zero-balance Anthropic key lists models and then refuses every
 * message. Those were false greens over keys every channel was failing on.
 *
 * Response shape (unified for both modes):
 *   { ok: true,  status: "ok",    provider, latency_ms, provider_response_ms }
 *   { ok: false, status: "error", provider, message, code? }
 *
 * `message` is one plain sentence (the same one a failed chat turn shows,
 * lib/os/channel/outcome.ts), never the provider's raw error body.
 *
 * Codes (when ok=false):
 *   provider_401 | provider_402 | provider_400_credit | provider_403 |
 *   provider_404 | provider_429 | provider_5xx | provider_400
 *                           → the provider refused the one-token completion
 *   "timeout"               → no response in 15s
 *   "network"               → fetch threw before HTTP
 *   "no_local_model"        → a local server with no model installed
 *   "no_key_on_file"        → mode 1, no saved key for provider
 *   "decrypt_failed"        → mode 1, decryptField threw
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
import { probeProvider, type ProbeResult } from "@/lib/agents/provider-probe";
import type { Provider } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter", "ollama"];

function inferShapeHint(provider: Provider, key: string): string {
  // Quick paste-error detection. Returns a single sentence appended to
  // a refused-key message when the key doesn't match the provider's shape.
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

function respond(provider: Provider, key: string, result: ProbeResult): NextResponse {
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      status: "ok",
      provider,
      latency_ms: result.latency_ms,
      provider_response_ms: result.latency_ms,
    });
  }
  // The shape hint explains a refused key, or a local "key" that is not a URL.
  const hint =
    result.code === "provider_401" || (provider === "ollama" && result.code === "network")
      ? inferShapeHint(provider, key)
      : "";
  return NextResponse.json({
    ok: false,
    status: "error",
    provider,
    message: hint ? `${result.message} ${hint}` : result.message,
    code: result.code,
  });
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
    return respond(provider, proposedKey, await probeProvider(provider, proposedKey));
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
    console.error("[agent-config.test-connection] saved key could not be decrypted", {
      tenantId: ctx.tenantId,
      provider,
      error: (err as Error).message,
    });
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        provider,
        code: "decrypt_failed",
        message: "The saved key could not be read. Use Replace key to enter it again.",
      },
      { status: 500 },
    );
  }

  return respond(provider, plain, await probeProvider(provider, plain));
}
