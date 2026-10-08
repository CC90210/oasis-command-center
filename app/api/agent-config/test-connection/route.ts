/**
 * POST /api/agent-config/test-connection
 *
 * One-shot provider-key validation. Two modes, single endpoint:
 *
 * 1. Test the SAVED key (default — body { provider }):
 *      Reads the key the CHANNELS answer on: the workspace's AI account
 *      (lib/ai/workspace-account.ts readWorkspaceAiAccount, the account
 *      app/api/agents/chat and Slack mentions read). Decrypts it, and probes
 *      the model saved with it. Never a teammate's personal key or another
 *      agent's row. No such key, or one for another provider, is said plainly
 *      (404) and nothing is probed.
 *
 * 2. Test a PROPOSED key before saving (body { provider, api_key, model? }):
 *      Skips the DB lookup and probes with the supplied key directly so
 *      the AgentConfigEditor's "Test connection" button can validate
 *      a key the operator just pasted but hasn't saved, on the model it is
 *      about to be saved with (or the provider's cheapest listed model when
 *      none is named). A blank api_key is refused, never tested as mode 1.
 *
 * Auth: session — both modes require a logged-in operator. Mode #2 is
 * NOT a public oracle for credential stuffing; the rate limit + session
 * gate keep it safe. Provider "ollama" (a local model server, whose "key" is
 * a web address the server calls) is the verified platform operator's only:
 * anyone else is refused 403 before anything is fetched (AIP-11).
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
 * lib/os/channel/outcome.ts, except a 403 or 404, which names the model it was
 * about), never the provider's raw error body.
 *
 * Codes (when ok=false):
 *   provider_401 | provider_402 | provider_400_credit | provider_403 |
 *   provider_404 | provider_429 | provider_5xx | provider_400
 *                           → the provider refused the one-token completion
 *   "timeout"               → no response in 15s
 *   "network"               → fetch threw before HTTP
 *   "no_local_model"        → a local server with no model installed
 *   "no_key_on_file"        → mode 1, no workspace key the channels use for
 *                             this provider (404)
 *   "config_unavailable"    → mode 1, the saved-key read failed (503)
 *   "decrypt_failed"        → mode 1, decryptField threw
 *   "empty_key"             → mode 2, api_key sent blank (400)
 *   "invalid_model"         → mode 2, model is not a plain model id (400)
 *   "invalid_provider"      → body.provider invalid
 *   "local_model_not_allowed" -> provider "ollama" from anyone but the
 *                             verified platform operator (403)
 *
 * Replaces the standalone /api/agent-config/test-key endpoint (deleted
 * 2026-05-23) — that was a duplicate built before realizing this one
 * existed. AgentConfigEditor now calls this with `{provider, api_key}`.
 */

import { NextRequest, NextResponse } from "next/server";
import { decryptField } from "@/lib/field-encryption";
import { resolveSessionContext } from "@/lib/api-auth";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";
import { probeProvider, type ProbeResult } from "@/lib/agents/provider-probe";
import { PROVIDER_REGISTRY, type Provider } from "@/lib/providers";
import {
  LOCAL_MODEL_REFUSAL,
  mayUseLocalModel,
  readWorkspaceAiAccount,
  type WorkspaceAiAccount,
} from "@/lib/ai/workspace-account";
import { billingForKey, isAiBudgetCode, modelCallMeter, type ModelCallMeter } from "@/lib/ai/usage";

/**
 * The probe spends, so it is metered like any model call (surface "probe"):
 * for the SESSION's workspace, on the workspace's own key (a pasted key is
 * about to become it; the platform key is never tested here).
 */
function probeMeter(provider: Provider, tenantId: string, userId: string): ModelCallMeter {
  return modelCallMeter({ tenantId, surface: "probe", ...billingForKey(provider, "tenant"), userId });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter", "ollama"];

/** The provider's name as Settings shows it. */
function providerLabel(provider: string | null | undefined): string {
  return PROVIDER_REGISTRY.find((r) => r.value === provider)?.label ?? String(provider || "unknown");
}

const INVALID_MODEL = Symbol("invalid_model");
/**
 * Mode 2's optional `model`: the model a pasted key is about to be saved with.
 * Absent or blank → null (the probe's cheapest model). Anything that is not a
 * plain model id is refused: some providers put the model in the URL path.
 */
function proposedModel(raw: unknown): string | null | typeof INVALID_MODEL {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return INVALID_MODEL;
  const model = raw.trim();
  if (!model) return null;
  return /^[A-Za-z0-9._:@+/-]{1,200}$/.test(model) && !model.includes("..") ? model : INVALID_MODEL;
}

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
  return NextResponse.json(
    {
      ok: false,
      status: "error",
      provider,
      message: hint ? `${result.message} ${hint}` : result.message,
      code: result.code,
    },
    // The month's AI budget refused the probe: nothing was sent to the provider.
    isAiBudgetCode(result.code) ? { status: 402 } : undefined,
  );
}

export async function POST(req: NextRequest) {
  const ctx = await resolveSessionContext();
  if (!ctx.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!(await canAccessSharedTenantResource(ctx))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { provider?: string; api_key?: string; model?: unknown };
  try {
    body = (await req.json()) as { provider?: string; api_key?: string; model?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const provider = String(body.provider || "") as Provider;
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ ok: false, error: `invalid_provider:${provider}`, code: "invalid_provider" }, { status: 400 });
  }
  // A local model server's "key" is a web address this server would call:
  // the verified platform operator's only, in both modes (AIP-11).
  if (provider === "ollama" && !(await mayUseLocalModel(ctx.userId, ctx.email))) {
    return NextResponse.json(
      { ok: false, status: "error", provider, code: "local_model_not_allowed", message: LOCAL_MODEL_REFUSAL },
      { status: 403 },
    );
  }

  // Mode 2: test the proposed key directly (before save). The api_key
  // field IS the value to test — skip the DB lookup entirely. It is tested on
  // the model it is about to be saved with, when the caller names one. A key
  // field that was sent blank is refused, never quietly turned into mode 1:
  // that would test a different key than the one the owner pasted.
  if (typeof body.api_key === "string") {
    const proposedKey = body.api_key.trim();
    if (!proposedKey) {
      return NextResponse.json(
        { ok: false, status: "error", provider, code: "empty_key", message: "Paste a key to test." },
        { status: 400 },
      );
    }
    const model = proposedModel(body.model);
    if (model === INVALID_MODEL) {
      return NextResponse.json(
        { ok: false, status: "error", provider, code: "invalid_model", message: "That model name is not valid." },
        { status: 400 },
      );
    }
    return respond(
      provider,
      proposedKey,
      await probeProvider(provider, proposedKey, { model, meter: probeMeter(provider, ctx.tenantId, ctx.userId) }),
    );
  }

  // Mode 1: test the saved key the CHANNELS answer on, and only that key: the
  // workspace's AI account (lib/ai/workspace-account.ts), the same account
  // app/api/agents/chat, Slack mentions and department readiness read. Not a
  // teammate's personal key and not another agent's row: a green "Test" on
  // either says nothing about the key every channel sends. The key is tested
  // on the model saved with it (lib/agents/provider-probe.ts WHICH MODEL).
  let row: WorkspaceAiAccount | null;
  try {
    row = await readWorkspaceAiAccount(ctx.tenantId);
  } catch (err) {
    // A failed read is not "no key on file": the owner would be told to add a
    // key that is already saved.
    console.error("[agent-config.test-connection] saved key could not be read", {
      tenantId: ctx.tenantId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        provider,
        code: "config_unavailable",
        message: "The saved key could not be read just now. Try again in a moment.",
      },
      { status: 503 },
    );
  }
  const encrypted = row?.encryptedApiKey || null;
  if (!encrypted) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        provider,
        code: "no_key_on_file",
        message:
          "No team-wide AI key is saved, so your channels have no key to test. A key saved for your own chats only is not one they use.",
      },
      { status: 404 },
    );
  }
  if (row?.provider !== provider) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        provider,
        code: "no_key_on_file",
        message: `Your channels use the team-wide ${providerLabel(row?.provider)} key, so there is no ${providerLabel(provider)} key of theirs to test.`,
      },
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

  return respond(
    provider,
    plain,
    await probeProvider(provider, plain, { model: row?.model, meter: probeMeter(provider, ctx.tenantId, ctx.userId) }),
  );
}
