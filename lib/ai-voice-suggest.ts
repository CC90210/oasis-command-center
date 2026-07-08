/**
 * lib/ai-voice-suggest.ts — per-rep AI voice-suggestion generator for the
 * Conversations composer (plan §6.3/§6.4, compiled-tumbling-gem.md Phase 2).
 *
 * Draft-only: this module has NO send path. It returns text; the composer
 * puts it in an editable draft field the operator reviews before sending.
 * Modeled on lib/ai-checkin-compose.ts: direct fetch to api.anthropic.com
 * with BRAVO_ANTHROPIC_API_KEY, Haiku, schema-validated JSON out, typed
 * errors so the route can map to a deterministic fallback.
 *
 * `voice_confidence` is NOT trusted from the model — it's computed
 * server-side from the agent_voice_profiles.confidence column (ground truth
 * from the JARVIS corpus-distillation worker), never from the LLM's
 * self-report, since a model has no reliable way to grade its own
 * voice-match accuracy against a corpus it never saw in full.
 */
import { wrapUntrusted, INJECTION_GUARD, safeJsonExtract } from "./llm-input-boundary";
import type { ConversationMessage } from "./conversation-threading";

const ANTHROPIC_VERSION = "2023-06-01";
const SUGGEST_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 700;
const MAX_MESSAGE_CHARS = 1500;

export type VoiceConfidence = "low" | "med" | "high";
export type VoiceMode = "full" | "ghost" | "rewrite";
export type ComposerChannel = "sms" | "email";

export type VoiceProfileInput = {
  compiled_prompt: string | null;
  confidence: VoiceConfidence;
} | null;

export type VoiceSuggestInput = {
  mode: VoiceMode;
  smsProfile: VoiceProfileInput;
  emailProfile: VoiceProfileInput;
  messages: ConversationMessage[];
  leadFacts: Record<string, unknown>;
  contactLabel: string;
  draft?: string;
  channel?: ComposerChannel;
  instruction?: string;
};

export type VoiceSuggestResult = {
  sms: string;
  email: { subject: string; body: string };
  voice_confidence: VoiceConfidence;
  generated_at: string;
};

const NEUTRAL_VOICE_PROMPT =
  "You are drafting on behalf of an MCA (merchant cash advance) broker rep. No voice sample exists yet for this rep, so use a neutral, professional register: warm, concise, no jargon, no exclamation-point energy.";

const LEAD_FACTS_ALLOW = [
  "name", "company", "business_name", "email", "phone", "stage",
  "requested_amount", "monthly_revenue", "avg_monthly_revenue",
  "industry", "city", "state",
] as const;

function confidenceRank(c: VoiceConfidence): number {
  return c === "high" ? 2 : c === "med" ? 1 : 0;
}
function rankToConfidence(r: number): VoiceConfidence {
  return r >= 2 ? "high" : r >= 1 ? "med" : "low";
}

function pickVoiceSystemBlock(profile: VoiceProfileInput, channel: ComposerChannel): string {
  if (profile && profile.compiled_prompt && profile.compiled_prompt.trim()) {
    return `--- ${channel.toUpperCase()} VOICE PROFILE (this rep's real writing style, distilled from their own past messages) ---\n${profile.compiled_prompt.trim()}`;
  }
  return `--- ${channel.toUpperCase()} VOICE PROFILE ---\n${NEUTRAL_VOICE_PROMPT}`;
}

function buildTranscript(messages: ConversationMessage[]): string {
  return messages
    .map((m) => {
      const body = (m.preview || m.subject || "").slice(0, MAX_MESSAGE_CHARS);
      const who = m.direction === "inbound" ? "merchant" : "rep";
      const header = `[msg:${m.id}] ${who} via ${m.channel} at ${m.at}`;
      const content = m.direction === "inbound" ? wrapUntrusted(body, { label: `msg:${m.id}` }) : body;
      return `${header}\n${content}`;
    })
    .join("\n\n");
}

function buildLeadFactsBlock(facts: Record<string, unknown>): string {
  const relevant: Record<string, unknown> = {};
  for (const k of LEAD_FACTS_ALLOW) {
    const v = facts[k];
    if (v !== undefined && v !== null && v !== "") relevant[k] = v;
  }
  // `notes` can carry pasted merchant text — fence it defensively same as
  // inbound messages rather than trust it as pure internal data.
  const notesBlock =
    typeof facts.notes === "string" && facts.notes.trim()
      ? `\n${wrapUntrusted(facts.notes, { label: "lead_notes" })}`
      : "";
  if (Object.keys(relevant).length === 0 && !notesBlock) return "[no lead file linked to this thread]";
  return `${JSON.stringify(relevant, null, 2)}${notesBlock}`;
}

const OUTPUT_CONTRACT =
  'Output ONLY a single JSON object, no markdown fences, no commentary: {"sms": string, "email": {"subject": string, "body": string}}';

const COMMON_RULES = `NEVER name a specific lender/funder by name - the brokerage is the funder from the merchant's perspective.
No em dashes - use commas, periods, or hyphens instead.
Ground every claim in the provided lead facts and conversation transcript - never invent dollar figures, dates, or approvals not present in the data.
${OUTPUT_CONTRACT}`;

function taskRules(mode: VoiceMode, channel: ComposerChannel, instruction?: string): string {
  if (mode === "ghost") {
    return `Task: suggest a short, single-sentence SMS opener (<=14 words) continuing this conversation naturally, as if the rep just started typing a reply. Put it in "sms". Leave "email" as {"subject":"","body":""}.\n${COMMON_RULES}`;
  }
  if (mode === "rewrite") {
    const targetField = channel === "sms" ? '"sms"' : '"email.body" (and "email.subject" only if it needs to change, else leave subject as an empty string)';
    return `Task: rewrite the DRAFT below in the rep's voice above.${
      instruction ? ` Apply this instruction: ${instruction}.` : " Improve clarity and tone while preserving the original meaning."
    } Preserve the original intent - do not add new claims or figures not already in the draft or transcript.
Return the rewritten text in ${targetField} only; leave the other channel's field(s) as empty strings.
${COMMON_RULES}`;
  }
  return `Task: draft a reply message from the rep to the merchant/lead, continuing the thread naturally in the rep's voice above. Provide BOTH a SMS-length version ("sms", under 320 characters) and an email version ("email": {"subject","body"}, 3-6 short paragraphs).
${COMMON_RULES}`;
}

export async function generateVoiceSuggestion(input: VoiceSuggestInput): Promise<VoiceSuggestResult> {
  const apiKey = (process.env.BRAVO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) throw new Error("anthropic_key_missing");

  const channel: ComposerChannel = input.channel === "email" ? "email" : "sms";
  const system = [
    pickVoiceSystemBlock(input.smsProfile, "sms"),
    pickVoiceSystemBlock(input.emailProfile, "email"),
    INJECTION_GUARD,
    taskRules(input.mode, channel, input.instruction),
  ].join("\n\n");

  const transcript =
    input.messages.length > 0 ? buildTranscript(input.messages) : "[no prior messages in this thread yet]";
  const factsBlock = buildLeadFactsBlock(input.leadFacts);

  const userParts = [
    `Lead facts:\n${factsBlock}`,
    `Conversation transcript (${input.messages.length} messages, oldest first):\n\n${transcript}`,
  ];
  if (input.mode === "rewrite" && typeof input.draft === "string" && input.draft.trim()) {
    userParts.push(`DRAFT to rewrite:\n${wrapUntrusted(input.draft, { label: "operator_draft" })}`);
  }
  userParts.push("Output ONLY the JSON object.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: SUGGEST_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userParts.join("\n\n") }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`anthropic_${res.status}: ${detail.slice(0, 300)}`);
  }

  const responseBody = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (responseBody.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim();

  const parsed = safeJsonExtract(text) as { sms?: unknown; email?: unknown } | null;
  if (!parsed) throw new Error(`voice_suggest_parse_failed: ${text.slice(0, 300)}`);

  const sms = typeof parsed.sms === "string" ? parsed.sms.trim().slice(0, 1200) : "";
  const emailObj =
    parsed.email && typeof parsed.email === "object" ? (parsed.email as Record<string, unknown>) : {};
  const subject = typeof emailObj.subject === "string" ? emailObj.subject.trim().slice(0, 200) : "";
  const emailBody = typeof emailObj.body === "string" ? emailObj.body.trim().slice(0, 4000) : "";

  if (!sms && !emailBody) {
    throw new Error(`voice_suggest_parse_failed: empty output. raw=${text.slice(0, 300)}`);
  }

  const relevantRanks =
    input.mode === "full"
      ? [confidenceRank(input.smsProfile?.confidence ?? "low"), confidenceRank(input.emailProfile?.confidence ?? "low")]
      : [confidenceRank((channel === "sms" ? input.smsProfile : input.emailProfile)?.confidence ?? "low")];
  const overallRank = Math.min(...relevantRanks);

  return {
    sms,
    email: { subject, body: emailBody },
    voice_confidence: rankToConfidence(overallRank),
    generated_at: new Date().toISOString(),
  };
}

/** Deterministic, non-AI fallback draft - used on any generation error or a
 *  sanitize rejection. Mirrors lib/ai-checkin-compose.ts's fallbackTemplate. */
export function fallbackVoiceDraft(contactLabel: string): { sms: string; email: { subject: string; body: string } } {
  const firstName = (contactLabel || "").trim().split(/\s+/)[0] || "there";
  return {
    sms: `Hi ${firstName}, just checking in on your file. Let me know if you have any questions.`,
    email: {
      subject: "Checking in",
      body: `Hi ${firstName},\n\nJust checking in on where things stand. Let me know if you have any questions.\n\nBest,`,
    },
  };
}
