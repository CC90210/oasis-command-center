/**
 * Running one turn of the role-play, and the debrief at the end.
 *
 * ON THE SEAM. Both calls go through `inferText`, the subscription path, with
 * the transcript serialised into the prompt. An earlier note in this project
 * said the role-play could not use `inferText` because it is one-shot with no
 * messages array. That is true of NATIVE multi-turn and it is not a reason to
 * leave the seam: serialising the call so far into the prompt gives the same
 * conversation, and it keeps a rep's practice on the subscription rather than a
 * third-party aggregator, which is what the platform fallback in the streaming
 * seam resolves to. Slower, and worth it. A pause before an owner answers reads
 * as thinking.
 *
 * The dedupe key `inferText` builds covers the whole prompt, and the prompt
 * contains the whole transcript, so two calls collide only when they are
 * identical to that point. That is acceptable here and would not be if money
 * moved on the answer.
 */

import { inferText } from "@/lib/subscription-infer";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import {
  MAX_REP_CHARS,
  MAX_TURNS,
  buildDebriefPrompt,
  buildOwnerSystemPrompt,
  buildTurnPrompt,
  DEBRIEF_SYSTEM_PROMPT,
  parseDebrief,
  parseOwnerReply,
  type Debrief,
  type OwnerReply,
  type Turn,
} from "@/lib/training/roleplay/prompt";
import type { RoleplayScenario } from "@/lib/training/roleplay/scenarios";

const OWNER_MAX_TOKENS = 300;
const DEBRIEF_MAX_TOKENS = 700;

export class RoleplayRejected extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "RoleplayRejected";
    this.reason = reason;
  }
}

/**
 * Checks a transcript before it costs anything.
 *
 * Caps exist because a practice tool that a rep can leave running is a bill
 * nobody is watching, and because a real cold call does not last forty
 * exchanges. Both limits are refused loudly rather than silently truncated: a
 * rep whose last line was quietly dropped would blame the owner's reply.
 */
export function assertTranscriptSane(transcript: Turn[]): void {
  if (transcript.length > MAX_TURNS) {
    throw new RoleplayRejected(
      "call_too_long",
      "That call has run longer than a real one would. Start a fresh one.",
    );
  }
  for (const turn of transcript) {
    // EVERY turn, not just the rep's. The whole transcript arrives from the
    // client, including the lines labelled as the owner's, so capping only the
    // rep's left the cap trivially bypassable: relabel the text as an owner
    // turn and send twenty-four of them. The role is a claim, not a fact, and
    // a limit that trusts it is not a limit.
    if (turn.text.length > MAX_REP_CHARS) {
      throw new RoleplayRejected(
        "turn_too_long",
        "That is longer than anybody says in one go on a phone. Shorten it.",
      );
    }
    if (turn.text.trim().length === 0) {
      throw new RoleplayRejected("empty_turn", "There is an empty line in that call.");
    }
  }
}

/** The owner's next line. */
export async function ownerTurn(
  scenario: RoleplayScenario,
  transcript: Turn[],
): Promise<OwnerReply> {
  assertTranscriptSane(transcript);

  const inf = await inferText({
    source: "training-roleplay",
    system: buildOwnerSystemPrompt(scenario),
    prompt: buildTurnPrompt(scenario, transcript),
    maxTokens: OWNER_MAX_TOKENS,
    tenantId: WEBDEV_TENANT_ID,
    modelTier: "smart",
  });
  if (!inf.ok) {
    // `pending` means the job is alive and a retry collects it; terminal means
    // it will not. The caller renders these differently, so the distinction has
    // to survive rather than collapsing into one error.
    throw new RoleplayRejected(
      inf.pending ? "owner_thinking" : "owner_unavailable",
      inf.pending
        ? "They are still thinking. Try that again in a moment."
        : `Could not reach the practice partner: ${inf.error}`,
    );
  }

  try {
    return parseOwnerReply(inf.text);
  } catch {
    throw new RoleplayRejected(
      "owner_unusable",
      "That came back as nothing usable. Say your line again.",
    );
  }
}

/** The review, after the call. */
export async function debrief(scenario: RoleplayScenario, transcript: Turn[]): Promise<Debrief> {
  assertTranscriptSane(transcript);
  if (transcript.filter((t) => t.role === "rep").length === 0) {
    throw new RoleplayRejected("nothing_to_review", "You have not said anything yet.");
  }

  const inf = await inferText({
    source: "training-roleplay-debrief",
    system: DEBRIEF_SYSTEM_PROMPT,
    prompt: buildDebriefPrompt(scenario, transcript),
    maxTokens: DEBRIEF_MAX_TOKENS,
    tenantId: WEBDEV_TENANT_ID,
    modelTier: "smart",
  });
  if (!inf.ok) {
    throw new RoleplayRejected(
      inf.pending ? "review_pending" : "review_unavailable",
      inf.pending
        ? "The review is still being written. Try again in a moment."
        : `Could not get a review: ${inf.error}`,
    );
  }
  return parseDebrief(inf.text);
}
