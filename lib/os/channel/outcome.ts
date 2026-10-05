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
  // The workspace's monthly AI budget (lib/ai/usage.ts): no provider was asked.
  "ai_budget_exhausted", //    the month's cap is used (HTTP 402)
  "ai_budget_unpriced_model", // a cap is set and the model has no verified price (HTTP 402)
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
 */
export function classifyStreamError(message: string): TurnFailureCode {
  const msg = String(message || "");
  if (msg === "missing_api_key") return "agent_not_configured";
  if (msg === "ai_budget_exhausted" || msg === "ai_budget_unpriced_model") return msg;
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
    sentence: "The AI model this channel uses was not found. Pick another model in AI settings.",
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
};

const UNKNOWN: FailureCopy = {
  sentence: "Something went wrong sending that. Try again.",
  short: "the last reply failed",
  fix: null,
};

/**
 * The copy for a code: a turn failure, or one of the route's own refusals.
 * `canManageAi` is whether the viewer may open AI settings (owners/admins); for
 * anyone else the fix link would 404, so the sentence says who can fix it.
 */
export function failureCopy(code: string | null | undefined, opts: { canManageAi: boolean }): FailureCopy {
  if (isTurnFailureCode(code)) {
    const c = COPY[code];
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
 */
export function channelFailure(outcomes: readonly TurnOutcome[], channelKey: string): { code: string } | null {
  const newest = outcomes
    .filter((o) => !saysNothingAboutTheKey(o))
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
