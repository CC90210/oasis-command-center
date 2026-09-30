/**
 * lib/ai/usage-codes.ts — the refusal codes of the AI usage ledger, and the one
 * sentence each shows an owner.
 *
 * PURE: no imports, so lib/providers.ts (which client components import for
 * PROVIDER_REGISTRY) and lib/os/channel/outcome.ts can name these codes without
 * pulling the server-only recorder (lib/ai/usage.ts) into a browser bundle.
 */

/** The month's cap would be passed by this call (docs/os-revamp/03 §d.3). HTTP 402. */
export const AI_BUDGET_EXHAUSTED = "ai_budget_exhausted";
/**
 * The tenant has a cap, and the model has no verified price, so the call's worst
 * case cannot be reserved against it. Refused rather than run unmetered past a
 * hard cap. HTTP 402.
 */
export const AI_BUDGET_UNPRICED_MODEL = "ai_budget_unpriced_model";
/**
 * The budget or the price table could not be read. The call is refused (a cap
 * that cannot be read cannot be enforced); not a budget verdict, so not a 402.
 */
export const AI_USAGE_UNAVAILABLE = "ai_usage_unavailable";
/** What an owner reads for AI_USAGE_UNAVAILABLE (the channel's copy, lib/os/channel/outcome.ts). */
export const AI_USAGE_UNAVAILABLE_SENTENCE = "We could not check this workspace's AI budget just now. Try again in a moment.";
/**
 * The ledger's tables do not exist (bravo__192 is not applied). Logged, never
 * shown: a table that does not exist holds no cap, so the call runs uncapped
 * and unrecorded instead of every AI feature going down with it.
 */
export const AI_USAGE_LEDGER_NOT_INSTALLED = "ai_usage_ledger_not_installed";

export const AI_BUDGET_CODES = [AI_BUDGET_EXHAUSTED, AI_BUDGET_UNPRICED_MODEL] as const;
export type AiBudgetCode = (typeof AI_BUDGET_CODES)[number];

export function isAiBudgetCode(code: unknown): code is AiBudgetCode {
  return typeof code === "string" && (AI_BUDGET_CODES as readonly string[]).includes(code);
}

/** What an owner reads. Never names a model vendor's error text. */
export const AI_BUDGET_SENTENCES: Record<AiBudgetCode, string> = {
  [AI_BUDGET_EXHAUSTED]: "This month's AI budget is used. The owner can raise it.",
  [AI_BUDGET_UNPRICED_MODEL]:
    "This workspace has a monthly AI budget, and the AI model it uses has no verified price, so it can't run under that budget. The owner can pick another model.",
};

/**
 * The SSE `error` frame for a stream error message: a budget refusal carries
 * its code and the owner's sentence; any other message passes through as before.
 */
export function sseErrorFrame(message: string): { message: string; code?: AiBudgetCode } {
  return isAiBudgetCode(message) ? { code: message, message: AI_BUDGET_SENTENCES[message] } : { message };
}

/**
 * The code a failed `meter.begin()` stands for: a budget refusal keeps its own
 * code; anything else (the budget or price read failed) is ai_usage_unavailable.
 */
export function meterRefusalCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return isAiBudgetCode(code) ? code : AI_USAGE_UNAVAILABLE;
}
