/**
 * POST /api/manifest/chat
 *
 * Conversational manifest editor. The operator sends a natural-language
 * request (with optional prior turns); we ask their configured LLM to
 * propose mutations as a JSON envelope, dry-run them against the live
 * manifest, and return:
 *
 *   {
 *     explanation: string,        // AI's narration
 *     mutations:   MutationArgs[],// proposed mutations (possibly [])
 *     preview_manifest: TenantManifest,
 *     diff:        DiffEntry[],
 *     ai_message:  string         // the raw assistant message for chat history
 *   }
 *
 * The user then reviews the diff. Hitting "Apply" sends the same `mutations`
 * to POST /api/manifest/<slug> for atomic persistence + audit logging. The
 * AI never persists directly — proposals require explicit human consent.
 *
 * This endpoint is auth-gated and admin-gated (same as /api/manifest/<slug>
 * POST). It answers on the caller's own saved key, else the workspace's AI
 * account (lib/ai/workspace-account.ts readPersonAiAccount, the account every
 * department chat uses), so manifest editing uses the tenant's own provider
 * quota.
 */

import { NextResponse, type NextRequest } from "next/server";
import { decryptField } from "@/lib/field-encryption";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { streamChat, type ChatMessage, type Provider } from "@/lib/providers";
import {
  LOCAL_MODEL_PROVIDER,
  LOCAL_MODEL_REFUSAL,
  mayUseLocalModel,
  readPersonAiAccount,
  type UsableAiAccount,
} from "@/lib/ai/workspace-account";
import { operatorPlatformFallback } from "@/lib/operator-credentials";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { getManifest, manifestExists } from "@/lib/manifest/loader";
import {
  applyMutations,
  ManifestMutationError,
  type MutationArgs,
} from "@/lib/manifest/mutators";
import { diffManifests } from "@/lib/manifest/diff";
import { buildManifestEditorPrompt } from "@/lib/manifest/ai-prompt";
import { parseAIEnvelope } from "@/lib/manifest/ai-parser";
import { manifestWriteGuards } from "@/lib/manifest/guards";
import { billingForKey, budgetRefusalResponse, isAiBudgetCode, modelCallMeter } from "@/lib/ai/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Body = {
  slug?: string;
  message?: string;
  history?: ChatMessage[];
};

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const slug = (body.slug || "").trim().toLowerCase();
  const message = (body.message || "").trim();
  if (!slug || !(await manifestExists(slug))) {
    return NextResponse.json({ ok: false, error: "unknown_tenant" }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ ok: false, error: "empty_message" }, { status: 400 });
  }

  // Authorisation — must belong to a tenant and have admin/owner role.
  const service = getServiceSupabase();
  const profileQuery = await service
    .from("user_profiles")
    .select("tenant_id, team_role, is_owner, admin_access")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const profile = profileQuery.data as
    | { tenant_id: string | null; team_role: string; is_owner: boolean; admin_access: boolean | null }
    | null;
  if (!profile?.tenant_id) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 403 });
  }
  // Editing the manifest (tabs / data model) is a full-admin capability.
  if (
    !profile.is_owner &&
    profile.team_role !== "admin" &&
    profile.team_role !== "owner" &&
    profile.admin_access !== true
  ) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Defense-in-depth — same guards the POST persistence endpoint enforces,
  // shared via lib/manifest/guards.ts. Surface them HERE so we never waste
  // an LLM call on a request the save step would reject anyway.
  const guard = await manifestWriteGuards(slug, profile.tenant_id);
  if (!guard.ok) {
    return NextResponse.json(
      { ok: false, error: guard.error, reason: guard.reason },
      { status: guard.status }
    );
  }

  // Provider resolution: the caller's own key first, then the workspace's AI
  // account (lib/ai/workspace-account.ts), so manifest editing uses the
  // tenant's own LLM quota.
  let cfg: UsableAiAccount | null;
  try {
    cfg = await readPersonAiAccount(profile.tenant_id, user.id);
  } catch (err) {
    // A failed read is not "no account": the owner would be sent to connect one
    // that may well be connected.
    console.error("[manifest.chat.ai_account]", { tenantId: profile.tenant_id, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { ok: false, error: "config_unavailable", message: "We could not read this workspace's AI settings just now. Try again in a moment." },
      { status: 503 },
    );
  }

  // A saved local model server answers for the verified operator only: its
  // "key" is a web address this server would call (lib/ai/workspace-account.ts).
  const localModelAllowed = cfg?.provider === LOCAL_MODEL_PROVIDER ? await mayUseLocalModel(user.id, user.email) : false;
  if (cfg?.provider === LOCAL_MODEL_PROVIDER && !localModelAllowed) {
    return NextResponse.json({ ok: false, error: "local_model_not_allowed", message: LOCAL_MODEL_REFUSAL }, { status: 403 });
  }

  let provider: Provider;
  let model: string;
  let apiKey = "";
  let keySource: "tenant" | "platform" = "tenant";

  if (cfg) {
    provider = cfg.provider;
    model = cfg.model;
    try {
      apiKey = decryptField(cfg.encryptedApiKey);
    } catch {
      return NextResponse.json({ ok: false, error: "key_decrypt_failed" }, { status: 500 });
    }
  } else {
    // The platform key bills OASIS: verified operator only (lib/platform-operator.ts).
    const fallback = (await isPlatformOperatorForAuthUser(user.id, user.email)) ? operatorPlatformFallback() : null;
    if (!fallback) {
      return NextResponse.json(
        {
          ok: false,
          error: "agent_not_configured",
          hint: "Connect an AI account in Settings > AI brain.",
          message: "Connect an AI account in Settings > AI brain.",
        },
        { status: 412 }
      );
    }
    provider = fallback.provider;
    model = fallback.model;
    apiKey = fallback.apiKey;
    keySource = "platform";
  }

  const manifest = await getManifest(slug);
  const system = buildManifestEditorPrompt({ tenantSlug: slug, manifest });

  const history = Array.isArray(body.history) ? body.history : [];
  const messages: ChatMessage[] = [
    ...history.filter((m) => m.role === "user" || m.role === "assistant"),
    { role: "user", content: message },
  ];

  // Single-shot consume of streamChat. We don't stream to the browser for the
  // editor — the UX is "user types, AI proposes, diff renders, user clicks
  // Apply." A streaming explanation would feel chatty without helping the
  // operator make a faster decision. Streaming can come back in a Phase 2.1
  // polish pass.
  const isOllama = provider === "ollama";
  let aiText = "";
  let streamError: string | null = null;
  try {
    for await (const ev of streamChat({
      provider,
      model,
      apiKey: isOllama ? "" : apiKey,
      baseUrl: isOllama ? apiKey : undefined,
      allowLocalModel: localModelAllowed,
      system,
      messages,
      maxTokens: 2048,
      meter: modelCallMeter({
        tenantId: profile.tenant_id,
        surface: "manifest.chat",
        ...billingForKey(provider, keySource),
        teammateId: "bravo",
        userId: user.id,
      }),
    })) {
      if (ev.type === "delta") aiText += ev.text;
      else if (ev.type === "error") streamError = ev.message;
    }
  } catch (err) {
    streamError = err instanceof Error ? err.message : "stream_failed";
  }

  if (isAiBudgetCode(streamError)) return budgetRefusalResponse(streamError);
  if (streamError) {
    return NextResponse.json({ ok: false, error: "llm_call_failed", message: streamError }, { status: 502 });
  }

  const parsed = parseAIEnvelope(aiText);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "ai_envelope_invalid", reason: parsed.error, ai_message: aiText },
      { status: 502 }
    );
  }

  // Dry-run mutations against the current manifest to validate + diff.
  let preview;
  try {
    preview = applyMutations(manifest, parsed.envelope.mutations);
  } catch (err) {
    if (err instanceof ManifestMutationError) {
      return NextResponse.json({
        ok: false,
        error: "mutation_rejected",
        field: err.field,
        reason: err.reason,
        explanation: parsed.envelope.explanation,
        mutations: parsed.envelope.mutations,
        ai_message: aiText,
      }, { status: 422 });
    }
    throw err;
  }

  const diff = diffManifests(manifest, preview);

  return NextResponse.json({
    ok: true,
    explanation: parsed.envelope.explanation,
    mutations: parsed.envelope.mutations as MutationArgs[],
    preview_manifest: preview,
    diff,
    ai_message: aiText,
  });
}
