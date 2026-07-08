/**
 * POST /api/conversations/voice-suggest
 *
 * On-the-spot, per-rep-voice draft suggestions for the Conversations
 * composer (plan §6.3/§6.4, compiled-tumbling-gem.md Phase 2). Draft-only -
 * this route has NO send path. It returns text; the operator reviews,
 * edits, and sends through the existing /api/conversations/reply or
 * /api/leads/[id]/email paths (which carry their own opt-out / dry-run
 * gates unchanged by this route).
 *
 * Body: {
 *   lead_id?: string, thread_key?: string,        // at least one required
 *   mode?: 'full' | 'ghost' | 'rewrite',            // default 'full'
 *   draft?: string,                                 // required for 'rewrite'
 *   channel?: 'sms' | 'email',                      // which field 'rewrite' targets
 *   instruction?: string,                            // tone-tool hint, e.g. "more formal"
 * }
 *
 * Voice owner: the lead's assigned rep (tenant_records.data.assigned_to)
 * when the thread is lead-linked and the requester can view it (canViewLead,
 * mirroring /api/leads/[id]/detail); otherwise the requesting user. Once the
 * Phase 3 spine lands, `owner_agent_id` on conversation_threads replaces
 * this heuristic.
 *
 * Messages are re-queried server-side (never a client-supplied transcript).
 * Inbound (merchant) messages are fenced with the ported llm-input-boundary
 * guard before reaching the model. Output is schema-validated, then run
 * through sanitizeBlastMessage (lender-name block + em-dash strip) before
 * it's returned; a rejection swaps in a deterministic fallback rather than
 * shipping unsafe text, flagged via `sanitized:false`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";
import { loadThreadForAi } from "@/lib/lead-interactions-queries";
import {
  generateVoiceSuggestion,
  fallbackVoiceDraft,
  type VoiceMode,
  type VoiceProfileInput,
  type VoiceConfidence,
  type ComposerChannel,
} from "@/lib/ai-voice-suggest";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_MODES: VoiceMode[] = ["full", "ghost", "rewrite"];

function toVoiceProfile(row: { compiled_prompt: string | null; confidence: string | null } | undefined): VoiceProfileInput {
  if (!row) return null;
  const confidence: VoiceConfidence = row.confidence === "high" || row.confidence === "med" ? row.confidence : "low";
  return { compiled_prompt: row.compiled_prompt, confidence };
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json(
      { ok: false, error: sess.reason },
      { status: sess.reason === "no_session" ? 401 : 400 },
    );
  }

  let body: {
    lead_id?: unknown;
    thread_key?: unknown;
    mode?: unknown;
    draft?: unknown;
    channel?: unknown;
    instruction?: unknown;
  };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  let threadKey = typeof body.thread_key === "string" ? body.thread_key.trim() : "";
  const bodyLeadId = typeof body.lead_id === "string" && UUID_RE.test(body.lead_id) ? body.lead_id : null;
  if (!threadKey && bodyLeadId) threadKey = `lead:${bodyLeadId}`;
  if (!threadKey) {
    return NextResponse.json({ ok: false, error: "thread_key_required" }, { status: 400 });
  }

  const mode: VoiceMode = VALID_MODES.includes(body.mode as VoiceMode) ? (body.mode as VoiceMode) : "full";
  const draft = typeof body.draft === "string" ? body.draft.slice(0, 4000) : undefined;
  const channel: ComposerChannel = body.channel === "email" ? "email" : "sms";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 200) : undefined;
  if (mode === "rewrite" && !draft?.trim()) {
    return NextResponse.json({ ok: false, error: "draft_required_for_rewrite" }, { status: 400 });
  }

  const thread = await loadThreadForAi(sess.tenantId, threadKey, { limit: 15 });
  const leadId = thread?.lead_id ?? bodyLeadId;
  const contactLabel = thread?.contact_label || "";

  const db = getServiceSupabase();

  // Voice owner + grounding lead facts. Mirrors /api/leads/[id]/detail's
  // canViewLead gate: a lead this requester can't open must not leak its
  // facts into a prompt, or silently pick its assigned rep's voice for them
  // to read. Fail closed to "not found" (not a generic 500) on a locked lead.
  let leadFacts: Record<string, unknown> = {};
  let repUserId = sess.userId;
  if (leadId) {
    const { data: leadRow } = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", sess.tenantId)
      .eq("entity_type", "lead")
      .eq("id", leadId)
      .maybeSingle();
    const leadData = (leadRow as { data: Record<string, unknown> } | null)?.data ?? null;
    if (leadData) {
      if (!canViewLead({ isAdmin: sess.isAdmin, userId: sess.userId }, leadData, leadScopingEnabled())) {
        return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      }
      leadFacts = leadData;
      if (typeof leadData.assigned_to === "string" && leadData.assigned_to.trim()) {
        repUserId = leadData.assigned_to.trim();
      }
    }
  }

  const { data: profileRows } = await db
    .from("agent_voice_profiles")
    .select("channel, compiled_prompt, confidence")
    .eq("tenant_id", sess.tenantId)
    .eq("rep_user_id", repUserId)
    .in("channel", ["sms", "email"]);
  const rows = (profileRows || []) as Array<{ channel: string; compiled_prompt: string | null; confidence: string | null }>;
  const smsProfile = toVoiceProfile(rows.find((r) => r.channel === "sms"));
  const emailProfile = toVoiceProfile(rows.find((r) => r.channel === "email"));

  try {
    const result = await generateVoiceSuggestion({
      mode,
      smsProfile,
      emailProfile,
      messages: thread?.messages ?? [],
      leadFacts,
      contactLabel,
      draft,
      channel,
      instruction,
    });

    const smsSanitize = result.sms ? await sanitizeBlastMessage(sess.tenantId, result.sms) : { ok: true as const, cleaned: "" };
    const emailSanitize = result.email.body
      ? await sanitizeBlastMessage(sess.tenantId, result.email.body)
      : { ok: true as const, cleaned: "" };

    if (!smsSanitize.ok || !emailSanitize.ok) {
      const sanitizeReason = !smsSanitize.ok ? smsSanitize.reason : !emailSanitize.ok ? emailSanitize.reason : "safety_check_failed";
      console.error("[conversations.voice-suggest] sanitize rejected AI output", sanitizeReason);
      const fb = fallbackVoiceDraft(contactLabel);
      return NextResponse.json({
        ok: true,
        sms: fb.sms,
        email: fb.email,
        voice_confidence: "low",
        sanitized: false,
        sanitize_reason: sanitizeReason,
        generated_at: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      ok: true,
      sms: smsSanitize.cleaned,
      email: { subject: result.email.subject, body: emailSanitize.cleaned },
      voice_confidence: result.voice_confidence,
      sanitized: true,
      generated_at: result.generated_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let status = 500;
    let errorTag = "voice_suggest_failed";
    if (message === "anthropic_key_missing") {
      status = 503;
      errorTag = "ai_unavailable";
    } else if (message.startsWith("voice_suggest_parse_failed")) {
      status = 502;
      errorTag = "voice_suggest_parse_failed";
    }
    console.error("[conversations.voice-suggest] failed", message);
    const fb = fallbackVoiceDraft(contactLabel);
    return NextResponse.json(
      {
        ok: false,
        error: errorTag,
        message,
        fallback: { sms: fb.sms, email: fb.email, voice_confidence: "low" as const },
      },
      { status },
    );
  }
}
