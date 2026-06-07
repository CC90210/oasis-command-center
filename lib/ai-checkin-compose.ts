/**
 * AI-driven check-in email composer.
 *
 * Replaces the hardcoded "Hey {firstName}, just checking in..." template
 * that LeadActionToolbar opened to. CC 2026-06-06: "the message we send
 * to clients or leads needs to sign off correctly. It needs to be more
 * personalised and detailed, and it needs to be filled in with the
 * dynamic values (their business name, R&D, etc.) as soon as I click
 * Send."
 *
 * Inputs: the lead's data + recent interactions + the operator's profile.
 * Output: { subject, body } — body is plain-text, lined for human edit,
 * signed off with the operator's first name. send_gateway wraps in the
 * OASIS branded HTML on the way out.
 *
 * Failure modes:
 *   - No BRAVO_ANTHROPIC_API_KEY → throws "anthropic_key_missing"
 *   - Anthropic non-2xx → throws "anthropic_<status>"
 *   - Claude returns malformed JSON → throws "compose_parse_failed" with
 *     the raw text slice so the route can fall back to the template path
 */

import { OASIS_CHECKIN_COMPOSE_PROMPT } from "./prompts";

const ANTHROPIC_VERSION = "2023-06-01";
const COMPOSE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 800;

export interface CheckinInteractionSnapshot {
  type: string;
  direction?: string | null;
  channel?: string | null;
  created_at: string;
  agent_source?: string | null;
  subject?: string | null;
  content_preview?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ComposeCheckinInput {
  leadData: Record<string, unknown>;
  interactions: CheckinInteractionSnapshot[];
  daysSinceLastTouch: number | null;
  operator: {
    /** Full name as it should appear in the sign-off line. Falls back to
     * the display name, then the email-local-part, then "Operator". */
    full_name: string | null;
    display_name: string | null;
    email: string | null;
    brand: string | null;
  };
}

export interface ComposeCheckinResult {
  subject: string;
  body: string;
  composed_at: string;
}

function operatorFirstName(operator: ComposeCheckinInput["operator"]): string {
  const name = (operator.full_name || operator.display_name || "").trim();
  if (name) return name.split(/\s+/)[0];
  if (operator.email) return operator.email.split("@")[0];
  return "Operator";
}

function buildUserPrompt(input: ComposeCheckinInput): string {
  const relevant: Record<string, unknown> = {};
  const ALLOW = [
    "name", "company", "email", "phone", "source", "stage",
    "value_estimate", "notes", "title", "role", "industry", "city", "state",
    "ai_reasoning", "ai_next_action", "ai_next_action_rationale",
  ];
  for (const k of ALLOW) {
    const v = input.leadData[k];
    if (v !== undefined && v !== null && v !== "") {
      relevant[k] = v;
    }
  }

  const tape = input.interactions.slice(0, 10).map((i) => ({
    type: i.type,
    direction: i.direction || null,
    channel: i.channel || null,
    at: i.created_at,
    source: i.agent_source || null,
    subject: i.subject ? i.subject.slice(0, 120) : null,
    snippet: i.content_preview ? i.content_preview.slice(0, 200) : null,
    classification:
      (i.metadata && typeof i.metadata === "object"
        ? (i.metadata as Record<string, unknown>).classification
        : null) || null,
  }));

  const firstName = operatorFirstName(input.operator);
  const operatorBlock = {
    first_name: firstName,
    full_name: input.operator.full_name || null,
    brand: input.operator.brand || "OASIS AI",
    email: input.operator.email || null,
  };

  return `Compose the check-in email.

Operator (sign off as):
${JSON.stringify(operatorBlock, null, 2)}

Lead data:
${JSON.stringify(relevant, null, 2)}

Days since last touch: ${input.daysSinceLastTouch ?? "unknown (no record of prior contact)"}

Recent interactions (most recent first, ${tape.length} of ${input.interactions.length} shown):
${tape.length === 0
  ? "[none recorded — this may be a first-touch reach-out]"
  : JSON.stringify(tape, null, 2)}

Remember: sign off with first_name on its own line, then "OASIS AI Solutions" on the next line. Output ONLY the JSON object.`;
}

export async function composeCheckin(
  input: ComposeCheckinInput,
): Promise<ComposeCheckinResult> {
  const apiKey = (process.env.BRAVO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("anthropic_key_missing");
  }

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
      system: OASIS_CHECKIN_COMPOSE_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`anthropic_${res.status}: ${detail.slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
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

  return {
    subject: subject.slice(0, 200),
    body: composeBody,
    composed_at: new Date().toISOString(),
  };
}
