/**
 * sequence-rotation-compose.ts — AI rewrite for ONE drip email step.
 *
 * Adon 2026-07-20: "if a template gets too spammy we have to be able to
 * rotate it — you give me recommendations, or I type it in, or I paste from
 * our saved templates." This is the recommendation seam: given a drip email
 * step (its stage + current copy), produce a fresh, compliant variation the
 * operator can apply and edit before saving.
 *
 * Same shape + API path as lib/ai-checkin-compose.ts (oasis is a Vercel app;
 * the established pattern here is the paid BRAVO_ANTHROPIC_API_KEY, not the
 * JARVIS CLI helper — no local claude binary in a serverless route). The
 * caller (app/api/sequences/[id]/rotate-suggest) runs the output through the
 * fail-closed positioning guard before returning it, so a drift back to
 * broker/lender language never reaches the operator's editor.
 *
 * Failure modes (throw; caller maps to a 4xx/5xx with the message):
 *   - No API key            → "anthropic_key_missing"
 *   - Anthropic non-2xx     → "anthropic_<status>: <detail>"
 *   - Malformed / empty JSON → "compose_parse_failed: <raw slice>"
 */

const ANTHROPIC_VERSION = "2023-06-01";
const COMPOSE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 900;

/**
 * The compliance contract, hardwired. Mirrors the voice + NEVER rules
 * documented at the top of lib/sunbiz-templates-library.ts and the
 * load-bearing positioning guard (lib/integrations/blast-safety-core.ts).
 * Kept self-contained so this seam doesn't depend on the Phase-1 persona
 * module (lib/personas/sunbiz.ts) that isn't shipped yet.
 */
const SYSTEM_PROMPT = `You rewrite ONE automated follow-up email for SunBiz Funding's drip sequences. SunBiz funds small-business deals DIRECTLY. Your job: produce a FRESH VARIATION of the given email for the SAME funnel stage and the SAME intent — different wording, so a lead who already saw the old version doesn't get a carbon copy. Do not change what the email is trying to do.

HARD RULES — a single violation makes the output unusable:
- SunBiz IS the direct funder. Write first person: "we review your file", "our underwriting", "we fund you". NEVER say or imply the file goes to any third party. NEVER use the words "lender", "lenders", "our lenders", "lender network", "to lenders", "funders we work with", "shop", "shopped", or "broker".
- NEVER promise a specific rate, factor, approval, or dollar amount — the deal is not underwritten yet. "Up to $500,000" as a program ceiling is fine; a promise to THIS lead is not.
- NO em dashes and NO en dashes anywhere. Use commas, periods, or hyphens.
- NO AI-slop phrases: "just checking in", "circle back", "quick question", "i hope this finds you well", "moving forward", "looking forward to hearing back", "no pressure just", or manufactured urgency.
- NO sign-off and NO name line. The send system appends the rep's signature; a closing name here would double it.
- Keep the merge tokens EXACTLY as written if you use them: {{lead.first_name}} and {{lead.business_name}}. Do not invent other tokens and do not resolve them.
- No invented facts about the lead: no specific numbers, referrals, or events you weren't given.
- Voice: warm, plain, specific, low-pressure, a real person. Bank statements are the gate; we underwrite in house; real options usually in 24 to 48 hours; no cost to look, no obligation.

Output ONLY a JSON object: {"subject": "...", "body": "..."}. Body is plain text with line breaks (\\n). No markdown, no code fence, no commentary.`;

export interface RotationComposeInput {
  /** Funnel stage this drip fires on (trigger_filter.to), e.g. "viewed_application". */
  stage: string | null;
  /** Sequence display name for light context. */
  sequenceName: string;
  /** The email currently in the step — the thing being rewritten. */
  currentSubject: string;
  currentBody: string;
  /** Optional operator steer ("make it shorter", "lead with the deadline", ...). */
  instruction?: string | null;
  /** Appended on a guard-failure retry so the model self-corrects. */
  correction?: string | null;
}

export interface RotationComposeResult {
  subject: string;
  body: string;
}

function buildUserPrompt(input: RotationComposeInput): string {
  const stage = input.stage?.trim() || "general follow-up (no specific stage)";
  const lines = [
    `Funnel stage this drip fires on: ${stage}`,
    `Sequence: ${input.sequenceName}`,
    "",
    "Current email (rewrite into a fresh variation, same intent and stage):",
    `Subject: ${input.currentSubject || "(none set)"}`,
    "Body:",
    input.currentBody || "(none set)",
  ];
  if (input.instruction?.trim()) {
    lines.push("", `Operator's direction for the rewrite: ${input.instruction.trim()}`);
  }
  if (input.correction?.trim()) {
    lines.push(
      "",
      `Your previous attempt was rejected by the compliance guard: ${input.correction.trim()} Rewrite it so it passes.`,
    );
  }
  lines.push("", "Return ONLY the JSON object.");
  return lines.join("\n");
}

export async function composeRotationSuggestion(
  input: RotationComposeInput,
): Promise<RotationComposeResult> {
  const apiKey = (process.env.BRAVO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) throw new Error("anthropic_key_missing");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: COMPOSE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`anthropic_${res.status}: ${detail.slice(0, 300)}`);
  }

  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim();

  let cleaned = text;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }

  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`compose_parse_failed: ${text.slice(0, 300)}`);
  }

  const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
  const composeBody = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!subject || !composeBody) {
    throw new Error(`compose_parse_failed: missing subject or body. raw=${text.slice(0, 300)}`);
  }

  return { subject: subject.slice(0, 200), body: composeBody };
}
