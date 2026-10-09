/**
 * lib/os/channel/outcome.ts — what a failed channel turn means, in words an
 * owner can act on.
 *
 * WHY. A department channel used to show whatever the provider sent back —
 * `anthropic_400:{"type":"error","error":{"type":"invalid_request_error",...}}`
 * under an empty reply bubble — and its header kept saying "Working" because
 * readiness only asked whether a key was on file. A key on file is not a key
 * that works: a drained Anthropic balance answers 400, an OpenRouter account
 * with no credits answers 402, and the owner saw JSON.
 *
 * Every failure is reduced to ONE code here, once, on the server:
 *   - app/api/agents/chat classifies the provider error and records the code as
 *     the channel's last turn (lib/os/channel/turns.ts);
 *   - app/api/agent-config/test-connection classifies its 1-token probe the
 *     same way, on the model saved with the key (lib/agents/provider-probe.ts),
 *     so "Test" reads a refusal the way the channel does;
 *   - the channel (components/agents/AgentChat.tsx) and the department header
 *     (components/os/department/StatusPill.tsx) print the code's copy below.
 * A code the copy table does not know prints a generic sentence, never the raw
 * provider text.
 *
 * PURE: no imports, safe in client code and in bare-node tests.
 */

export const TURN_FAILURE_CODES = [
  // Workspace configuration — no provider was asked.
  "agent_not_configured", //  412: no workspace key, and not the verified operator
  "key_unreadable", //         the stored key could not be decrypted
  // The provider answered, and refused.
  "provider_401", //           bad or revoked key
  "provider_402", //           out of credits (OpenRouter)
  "provider_400_credit", //    400 that names the balance (Anthropic "credit balance is too low")
  "provider_403", //           key valid, not allowed to do this
  "provider_404", //           the model was not found
  "provider_429", //           rate-limited, or out of quota (OpenAI insufficient_quota is a 429)
  "provider_5xx", //           the provider is down
  "provider_400", //           any other 4xx the provider refused
  // The reply broke off.
  "provider_error", //         an error we could not read a status from
  "stream_failed", //          the stream threw mid-reply
  // The provider answered 200 and the reply had NO answer text
  // (lib/providers.ts EmptyReplyKind): never a success.
  "reply_empty_thinking", //   the output budget went to thinking (finish MAX_TOKENS / length)
  "reply_blocked", //          a safety or content filter stopped it
  "reply_empty", //            it ended normally with nothing in it
  // The workspace's monthly AI budget (lib/ai/usage.ts): no provider was asked.
  "ai_budget_exhausted", //    the month's cap is used (HTTP 402)
  "ai_budget_unpriced_model", // a cap is set and the model has no verified price (HTTP 402)
  // The engine is an AI app or local model on the paired computer
  // (lib/ai/agent-engine.ts, lib/ai/bridge-turn.ts).
  "bridge_unreachable", //     the paired computer could not be reached
  "cli_failed", //             it was reached, and the app there could not answer
] as const;

export type TurnFailureCode = (typeof TURN_FAILURE_CODES)[number];

export function isTurnFailureCode(code: unknown): code is TurnFailureCode {
  return typeof code === "string" && (TURN_FAILURE_CODES as readonly string[]).includes(code);
}

/**
 * Failures that belong to the workspace's AI ACCOUNT, not to one channel. Every
 * department channel runs on the same workspace key, so a refusal of that key in
 * Sales is also why Marketing will fail; and any newer successful turn anywhere
 * proves the account works again. The rest (a model the provider does not know,
 * a reply that broke off) are the channel's own until that channel answers.
 */
const ACCOUNT_SCOPED: ReadonlySet<TurnFailureCode> = new Set<TurnFailureCode>([
  // Every channel sends the account's ONE model (lib/os/department-agent.ts
  // reads no per-department model since 2026-10-09), so a model the provider
  // does not know fails them all, and a success anywhere proves it is known.
  "provider_404",
  "key_unreadable",
  "provider_401",
  "provider_402",
  "provider_400_credit",
  "provider_403",
  "provider_429",
  "provider_5xx",
  // One budget per workspace per month, shared by every channel.
  "ai_budget_exhausted",
  "ai_budget_unpriced_model",
  // One engine per workspace: every channel runs on the same paired computer.
  "bridge_unreachable",
  "cli_failed",
]);

export function isAccountScoped(code: TurnFailureCode): boolean {
  return ACCOUNT_SCOPED.has(code);
}

/**
 * "No AI account connected" is not a verdict on any key: no key was tried. The
 * route no longer records its 412, but a stream that ends in missing_api_key
 * still does, and such a row must not stand in for the key's real record, or a
 * member's 412 while the key was switched off would hide the 402 that key was
 * getting, and the header would read Working over a drained account. Whether a
 * key exists is answered by readiness (components/os/department/channel.ts),
 * which reads the key itself.
 */
function saysNothingAboutTheKey(o: TurnOutcome): boolean {
  return !o.ok && o.code === "agent_not_configured";
}

/** Wording a provider uses when the balance, not the request, is the problem. */
const BILLING_WORDS = /credit|balance|billing|insufficient|quota|payment|funds/i;
/** Wording a provider uses for a bad key on a status that is not 401 (Google answers 400). */
const BAD_KEY_WORDS = /api[ _-]?key not valid|invalid api[ _-]?key|invalid x-api-key|incorrect api key|api_key_invalid/i;
/**
 * Wording a provider uses for a model that is gone or unknown on a status that
 * is not 404: OpenRouter answers 400 "<slug> is not a valid model ID" for a
 * model it removed (researched 2026-10-08). Checked AFTER the bad-key and
 * billing words, so neither of those is ever read as a model problem.
 */
const MODEL_GONE_WORDS = /is not a valid model id/i;

/** An HTTP status plus the provider's error body, reduced to one code. */
export function classifyProviderStatus(status: number, detail: string): TurnFailureCode {
  if (status === 401) return "provider_401";
  if (status === 402) return "provider_402";
  if (status === 403) return "provider_403";
  if (status === 404) return "provider_404";
  if (status === 429) return "provider_429";
  if (status >= 500) return "provider_5xx";
  if (status >= 400) {
    if (BAD_KEY_WORDS.test(detail)) return "provider_401";
    if (BILLING_WORDS.test(detail)) return "provider_400_credit";
    if (MODEL_GONE_WORDS.test(detail)) return "provider_404";
    return "provider_400";
  }
  return "provider_error";
}

/**
 * The `message` of a lib/providers.ts streamChat error event, reduced to one
 * code. Its shapes, one per adapter:
 *   `<provider>_<status>:<body>`                             4xx
 *   `provider_temporarily_unavailable:<provider>_<status>`   5xx and 429
 *   `local_model_temporarily_unavailable:<status>`           Ollama 5xx and 429
 *   `missing_api_key`                                        no key reached it
 *   `ai_budget_exhausted` / `ai_budget_unpriced_model`       the budget refused it
 *                                                            (lib/ai/usage-codes.ts)
 *   `empty_reply:thinking|blocked|empty`                     a 200 with no answer text
 *                                                            (lib/providers.ts EmptyReplyKind)
 */
export function classifyStreamError(message: string): TurnFailureCode {
  const msg = String(message || "");
  if (msg === "missing_api_key") return "agent_not_configured";
  if (msg === "ai_budget_exhausted" || msg === "ai_budget_unpriced_model") return msg;
  if (msg === "empty_reply:thinking") return "reply_empty_thinking";
  if (msg === "empty_reply:blocked") return "reply_blocked";
  if (msg === "empty_reply:empty") return "reply_empty";
  // lib/ai/bridge-turn.ts: the paired computer, or the AI app on it.
  if (msg.startsWith("bridge_unreachable:")) return "bridge_unreachable";
  if (msg.startsWith("cli_error:")) return "cli_failed";
  const busy = /^(?:provider|local_model)_temporarily_unavailable:(?:[a-z]+_)?(\d{3})\b/.exec(msg);
  if (busy) return classifyProviderStatus(Number(busy[1]), "");
  const refused = /^(?:openrouter|anthropic|openai|google|ollama)_(\d{3}):([\s\S]*)$/.exec(msg);
  if (refused) return classifyProviderStatus(Number(refused[1]), refused[2]);
  return "provider_error";
}

/**
 * The route's own refusals (app/api/agents/chat JSON errors before any stream),
 * by the `error` field it sends, plus the two the channel detects itself.
 * Anything unlisted is "unknown": a generic sentence, never the raw text.
 */
const ROUTE_ERRORS = {
  unauthorized: "Your session ended. Sign in again to keep chatting.",
  slug_not_owned: "This chat belongs to another workspace.",
  no_tenant: "Your account is not part of a workspace yet.",
  unknown_tenant: "This workspace's agent settings are not set up yet.",
  agent_not_found: "This channel's AI teammate could not be found.",
  agent_not_visible: "This channel's AI teammate could not be found.",
  department_agent_mismatch: "This channel is out of date. Refresh the page and try again.",
  unknown_department: "This channel is out of date. Refresh the page and try again.",
  profile_unavailable: "We could not confirm your workspace just now. Try again in a moment.",
  workspace_unavailable: "We could not confirm your workspace just now. Try again in a moment.",
  config_unavailable: "We could not read this workspace's AI settings just now. Try again in a moment.",
  ai_usage_unavailable: "We could not check this workspace's AI budget just now. Try again in a moment.",
  // Client-side: the request never reached the route, or the stream closed
  // with no text and no reason.
  network: "Could not reach the server. Check your connection and try again.",
  empty_reply: "The reply came back empty. Try again.",
} as const;

export type FailureFix = { href: string; label: string };

export type FailureCopy = {
  /** One plain sentence for the channel. */
  sentence: string;
  /** A few words for the department header: "Not working: <short>". */
  short: string;
  /** Where to fix it, when the viewer can; null otherwise. */
  fix: FailureFix | null;
};

/** Settings › AI brain: the one page that holds the workspace's AI account. */
export const AI_SETTINGS_HREF = "/settings/ai";

const OPEN_AI_SETTINGS: FailureFix = { href: AI_SETTINGS_HREF, label: "Open AI settings" };
const OWNER_CAN_FIX = " An owner or admin can fix this in Settings.";

const COPY: Record<TurnFailureCode, { sentence: string; short: string; fix: FailureFix | null }> = {
  agent_not_configured: {
    sentence: "No AI account is connected for this workspace yet.",
    short: "no AI account connected",
    fix: { href: AI_SETTINGS_HREF, label: "Connect an AI account" },
  },
  key_unreadable: {
    sentence: "The saved AI key could not be read. Enter it again in AI settings.",
    short: "the saved AI key could not be read",
    fix: OPEN_AI_SETTINGS,
  },
  provider_401: {
    sentence: "Your AI account refused the request. Check its billing or key.",
    short: "AI account refused the key (check the key)",
    fix: OPEN_AI_SETTINGS,
  },
  provider_402: {
    sentence: "Your AI account refused the request. Check its billing or key.",
    short: "AI account refused the request (check billing)",
    fix: OPEN_AI_SETTINGS,
  },
  provider_400_credit: {
    sentence: "Your AI account refused the request. Check its billing or key.",
    short: "AI account refused the request (check billing)",
    fix: OPEN_AI_SETTINGS,
  },
  provider_403: {
    sentence: "Your AI account refused the request. Check its billing or key.",
    short: "AI account refused the request (check the key's access)",
    fix: OPEN_AI_SETTINGS,
  },
  provider_404: {
    // A 404 on a model call means the provider retired the model, or this AI
    // account may not use it (Google answers that way for its 2.5 models to
    // any project that never used them). It never means a bad key or no
    // credit: those have their own codes and words above.
    sentence:
      "The AI model this channel uses was not found: the provider has retired it or does not offer it to this AI account. Pick another model in AI settings.",
    short: "the AI model was not found",
    fix: OPEN_AI_SETTINGS,
  },
  provider_429: {
    sentence: "Your AI account is rate-limited or out of quota. Try again in a minute, or check its billing.",
    short: "AI account is rate-limited or out of quota",
    fix: OPEN_AI_SETTINGS,
  },
  provider_5xx: {
    sentence: "The AI provider is having trouble right now. Try again in a minute.",
    short: "the AI provider is down",
    fix: null,
  },
  provider_400: {
    sentence: "The AI provider rejected the request. Check the model and key in AI settings.",
    short: "the AI provider rejected the request",
    fix: OPEN_AI_SETTINGS,
  },
  provider_error: {
    sentence: "The reply could not be completed. Try again.",
    short: "the last reply failed",
    fix: null,
  },
  stream_failed: {
    sentence: "The reply stopped partway. Try again.",
    short: "the last reply stopped partway",
    fix: null,
  },
  reply_empty_thinking: {
    sentence:
      "The AI model used its whole answer budget thinking and sent no answer. Try again, or pick a faster model in AI settings.",
    short: "the AI model used its answer budget thinking",
    fix: OPEN_AI_SETTINGS,
  },
  reply_blocked: {
    sentence: "The AI provider's safety filter blocked this reply. Rephrase the message and try again.",
    short: "the provider's safety filter blocked the last reply",
    fix: null,
  },
  reply_empty: {
    sentence: "The AI model sent back an empty reply. Try again.",
    short: "the AI model sent back an empty reply",
    fix: null,
  },
  // Same words as lib/ai/usage-codes.ts AI_BUDGET_SENTENCES (tests/ai-usage-ledger.test.ts
  // pins them equal; this file stays import-free).
  ai_budget_exhausted: {
    sentence: "This month's AI budget is used. The owner can raise it.",
    short: "this month's AI budget is used",
    fix: null,
  },
  ai_budget_unpriced_model: {
    sentence:
      "This workspace has a monthly AI budget, and the AI model it uses has no verified price, so it can't run under that budget. The owner can pick another model.",
    short: "the AI model has no verified price",
    fix: OPEN_AI_SETTINGS,
  },
  bridge_unreachable: {
    sentence:
      "Your agents run on an AI app on your paired computer, and that computer could not be reached. Start the bridge on it, or choose an AI account in AI settings.",
    short: "the paired computer could not be reached",
    fix: OPEN_AI_SETTINGS,
  },
  cli_failed: {
    sentence:
      "The AI app on your paired computer could not answer. Check that it is installed and signed in on that computer, or choose another engine in AI settings.",
    short: "the AI app on the paired computer could not answer",
    fix: OPEN_AI_SETTINGS,
  },
};

const UNKNOWN: FailureCopy = {
  sentence: "Something went wrong sending that. Try again.",
  short: "the last reply failed",
  fix: null,
};

/**
 * The model a "not found" names, as data (lib/ai/model-registry.ts
 * modelFactsForCopy builds it; this file stays import-free): its name, who
 * offers it, and a model to pick instead.
 */
export type FailureModel = { label: string; vendor?: string | null; suggestion?: string | null };

/** provider_404 with the model it was about: named, why, and what to pick. */
function modelNotFound(m: FailureModel): { sentence: string; short: string } {
  const pick = m.suggestion ? `Pick another model in AI settings, such as ${m.suggestion}.` : "Pick another model in AI settings.";
  return {
    sentence: `The AI model ${m.label} was not found: ${m.vendor || "the provider"} has retired it or does not offer it to this AI account. ${pick}`,
    short: `the AI model ${m.label} was not found`,
  };
}

/**
 * The copy for a code: a turn failure, or one of the route's own refusals.
 * `canManageAi` is whether the viewer may open AI settings (owners/admins); for
 * anyone else the fix link would 404, so the sentence says who can fix it.
 * `model`, when the caller knows which model a provider_404 was about, names
 * it; every other code ignores it.
 */
export function failureCopy(
  code: string | null | undefined,
  opts: { canManageAi: boolean; model?: FailureModel | null },
): FailureCopy {
  if (isTurnFailureCode(code)) {
    const named = code === "provider_404" && opts.model?.label ? modelNotFound(opts.model) : null;
    const c = named ? { ...COPY[code], ...named } : COPY[code];
    if (!c.fix) return { ...c };
    return opts.canManageAi ? { ...c } : { sentence: c.sentence + OWNER_CAN_FIX, short: c.short, fix: null };
  }
  if (typeof code === "string" && code in ROUTE_ERRORS) {
    const sentence = ROUTE_ERRORS[code as keyof typeof ROUTE_ERRORS];
    return { sentence, short: UNKNOWN.short, fix: null };
  }
  return { ...UNKNOWN };
}

// ── The last turn, per channel ────────────────────────────────────────────

export type TurnOutcome = {
  channelKey: string;
  ok: boolean;
  /** A TurnFailureCode when !ok; null when ok. */
  code: string | null;
  /** ISO-8601 UTC. */
  at: string;
};

/**
 * The failure a channel's header should show, or null.
 *
 * `outcomes` is the workspace's recorded last turns, one per channel, any order.
 *   1. The workspace's newest ACCOUNT verdict — a success anywhere, or an
 *      account-scoped failure anywhere — speaks for every channel: they share
 *      one key. If it is a failure, this channel fails the same way.
 *   2. Otherwise this channel's own last turn, if it failed with a failure that
 *      is its own (not account-scoped, which step 1 already settled).
 * A code this build does not know is treated as the channel's own failure: an
 * unknown outcome is shown as a failure, never as "Working". A 412 ("no AI
 * account connected") is skipped in both steps (saysNothingAboutTheKey).
 *
 * `accountChangedAt` is when the workspace's AI account last changed (a new
 * key, provider or model). A failure recorded BEFORE it was about an account
 * the channels no longer send, so it says nothing now: it is skipped, and the
 * header shows no stale "model not found" after the model was switched
 * (CC, 2026-10-09). null = not known: every record counts, as before.
 */
export function channelFailure(
  outcomes: readonly TurnOutcome[],
  channelKey: string,
  accountChangedAt: string | null = null,
): { code: string } | null {
  const changed = accountChangedAt ? Date.parse(accountChangedAt) : NaN;
  const stale = (o: TurnOutcome) => !o.ok && Number.isFinite(changed) && Date.parse(o.at) < changed;
  const newest = outcomes
    .filter((o) => !saysNothingAboutTheKey(o) && !stale(o))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const accountVerdict = newest.find((o) => o.ok || (isTurnFailureCode(o.code) && isAccountScoped(o.code)));
  if (accountVerdict && !accountVerdict.ok) return { code: String(accountVerdict.code) };
  const own = newest.find((o) => o.channelKey === channelKey);
  if (own && !own.ok && !(isTurnFailureCode(own.code) && isAccountScoped(own.code))) {
    return { code: String(own.code ?? "provider_error") };
  }
  return null;
}

/** The recorded key for a department channel. */
export function departmentChannelKey(departmentKey: string): string {
  return `dept:${departmentKey}`;
}

/** The recorded key for a direct agent chat (the /t/<slug>/agent/<agent> preview). */
export function agentChannelKey(agentSlug: string): string {
  return `agent:${agentSlug}`;
}
