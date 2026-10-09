/**
 * lib/ai/model-registry.ts - the one place this app keeps its facts about AI
 * models: which ones each provider offers, which ones still answer, which ones
 * are going away and when, what each costs, and what a saved model that can no
 * longer be used moves to.
 *
 * WHY (2026-10-08). Every department chat in OASIS's own workspace failed for
 * nine days with "The AI model this channel uses was not found": the one saved
 * setting they all read named Google's gemini-2.5-pro, which Google now serves
 * only to projects that used it before (HTTP 404). Nothing in the app knew. The
 * pickers still offered it, the key test defaulted to its sibling, and the
 * price table had nothing newer. The model lists lived in five files.
 *
 * WHAT READS IT
 *   - lib/providers.ts PROVIDER_REGISTRY.models: every picker (Settings > AI
 *     brain, the connect dialog, /model), and the save routes' checks;
 *   - lib/agents/provider-probe.ts: the model a key is tested on when none is
 *     named (probeModel);
 *   - resolveModelForCall: every request built from a saved model
 *     (lib/providers.ts streamChat, lib/cloud-tool-runner.ts, the probe,
 *     lib/os/department-agent.ts). A saved model that is retired, limited to
 *     past users, or past its end date is sent as its replacement ON THE SAME
 *     PROVIDER, with the same key, and the ai_usage_events row records why
 *     (fallback_reason). Never another provider, never another key;
 *   - modelNote / modelChoices: the plain sentence Settings shows next to a
 *     saved model, and the picker that always lists the saved value;
 *   - scripts/update-saved-models.ts: moves saved rows whose model is gone or
 *     ending within REGISTRY_HORIZON_DAYS;
 *   - database/turso/bravo__204_model_prices_current.sql: the price rows,
 *     pinned equal to `prices` here by tests/model-registry.checks.ts (run by
 *     tests/ai-usage-ledger.test.ts).
 *
 * SOURCES. Every id, price, status and date below was read on
 * REGISTRY_VERIFIED_ON from the provider's own pages or API (the research file
 * behind this PR quotes each one). The pages:
 *   Anthropic  https://platform.claude.com/docs/en/about-claude/models/overview
 *              https://platform.claude.com/docs/en/about-claude/pricing
 *              https://platform.claude.com/docs/en/about-claude/model-deprecations
 *   OpenAI     https://developers.openai.com/api/docs/models/all
 *              https://developers.openai.com/api/docs/pricing
 *              https://developers.openai.com/api/docs/deprecations
 *              https://developers.openai.com/api/docs/guides/latest-model
 *   Google     https://ai.google.dev/gemini-api/docs/models
 *              https://ai.google.dev/gemini-api/docs/pricing
 *              https://ai.google.dev/gemini-api/docs/deprecations
 *              https://ai.google.dev/gemini-api/docs/changelog (2026-09-18 note)
 *   OpenRouter https://openrouter.ai/api/v1/models (live catalog; expiration_date)
 * Nothing here is guessed: a model the research did not verify is not listed,
 * and a saved id this file does not know is shown as itself, never swapped.
 *
 * WHAT "tools" MEANS. Whether tool calls work through the request this app
 * actually sends that provider: Anthropic's Messages API, OpenAI's Chat
 * Completions (with no reasoning_effort parameter), Google's generateContent,
 * OpenRouter's chat completions. OpenAI's GPT-6 models need OpenAI's newer
 * Responses API for tool calls (GPT-6 Luna and Sol only take them on Chat
 * Completions with reasoning_effort "none", which this app does not send), so
 * they are listed but not offered. OpenRouter's GPT-6 routes are not offered
 * either: how OpenRouter carries their tool calls is not verified yet.
 *
 * THE DEFAULT (the balanced pick, what a new connection starts on). On
 * Anthropic and on OpenRouter it stays Claude Sonnet 4.6, the default this app
 * has shipped since 2026-05. Claude Sonnet 5.5, Opus 5.5 and Fable 5.1 always
 * think before they answer: thinking cannot be turned off, it counts against
 * the reply's token limit, and the text they write between tool calls comes
 * back inside thinking blocks this app does not show or pass back yet. No 5.x
 * Claude model (Haiku 5.5 included) has been called through this app, so they
 * are offered but are not the default until a real key test and a tool-using
 * turn pass on them (PR #555 review). A gone model's replacement may still be
 * a 5.x model: a gone model fails every call, and its own vendor's successor
 * answers.
 *
 * PURE: no runtime imports (one type import), safe in client components and
 * bare-node tests. ASCII only (tests/worker-source-one-byte.test.ts).
 */
import type { BeginCall, ModelCall, ModelCallMeter } from "./usage";

/** The day every fact below was read from its source. */
export const REGISTRY_VERIFIED_ON = "2026-10-08";

/** A saved model ending within this many days is moved by scripts/update-saved-models.ts. */
export const REGISTRY_HORIZON_DAYS = 14;

export type RegistryProvider = "anthropic" | "openai" | "google" | "openrouter";
export const REGISTRY_PROVIDERS: readonly RegistryProvider[] = ["anthropic", "openai", "google", "openrouter"];

/**
 * current         the provider's current model.
 * preview         answers now; the provider may withdraw it with as little as two weeks' notice.
 * legacy          superseded but still answering, no end date announced.
 * deprecated      still answering, with an announced end date (endsOn).
 * access_limited  served only to accounts that used it before: a new account gets a 404.
 * retired         no longer answers (404).
 */
export const MODEL_STATUSES = ["current", "preview", "legacy", "deprecated", "access_limited", "retired"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export type ModelTier = "fast" | "balanced" | "deep";

/** One price, in USD per million tokens, from `from` (UTC day) on. */
export type PricePoint = {
  from: string;
  /** The tier applies to prompts ABOVE this many tokens (0 = the base tier). */
  promptTokensAbove: number;
  input: number;
  output: number;
  /** null: the price page lists no such rate. */
  cacheRead: number | null;
  cacheWrite: number | null;
};

export type RegistryModel = {
  id: string;
  label: string;
  status: ModelStatus;
  /** The first UTC day the model may stop answering (retired, shut down, OpenRouter expiration). null: none announced. */
  endsOn: string | null;
  /** The same provider's model a saved id moves to when this one cannot be used. null only for current and preview models with no successor. */
  replacement: string | null;
  /** Listed in the pickers: answering, not ending soon, and tool calls work through this app's request. */
  offered: boolean;
  tier: ModelTier | null;
  tools: boolean;
  streaming: boolean;
  /** Verified prices; [] when this file carries none (a model it does not offer). */
  prices: PricePoint[];
  source: string;
  /** Why it is not offered, or what an owner should know. */
  note?: string;
  /** For an access-limited model: who may still call it. Default: accounts that used it before. */
  limitedTo?: "past_users" | "verified";
};

export type ProviderModels = {
  provider: RegistryProvider;
  /** Who stops offering a model, in a sentence an owner reads. */
  vendor: string;
  /** The API this app sends this provider, which "tools" is measured against. */
  surface: string;
  /** The model a key with no model of its own is tested on (lib/agents/provider-probe.ts). */
  probeModel: string;
  probeNote: string;
  models: RegistryModel[];
  note?: string;
};

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS_URL = "https://platform.claude.com/docs/en/about-claude/models/overview";
const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_LIFECYCLE_URL = "https://platform.claude.com/docs/en/about-claude/model-deprecations";
const OPENAI_MODELS_URL = "https://developers.openai.com/api/docs/models/all";
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const OPENAI_LIFECYCLE_URL = "https://developers.openai.com/api/docs/deprecations";
const OPENAI_GPT6_URL = "https://developers.openai.com/api/docs/guides/latest-model";
const GOOGLE_MODELS_URL = "https://ai.google.dev/gemini-api/docs/models";
const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const GOOGLE_LIFECYCLE_URL = "https://ai.google.dev/gemini-api/docs/deprecations";
const GOOGLE_ACCESS_URL = "https://ai.google.dev/gemini-api/docs/changelog";
const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";

/** A price read on REGISTRY_VERIFIED_ON (the day the new rows take effect). */
const NEW = REGISTRY_VERIFIED_ON;
/** The day bravo__192 seeded the prices it carries (unchanged on REGISTRY_VERIFIED_ON). */
const SEEDED = "2026-09-29";

function price(from: string, input: number, output: number, cacheRead: number | null, cacheWrite: number | null, promptTokensAbove = 0): PricePoint {
  return { from, promptTokensAbove, input, output, cacheRead, cacheWrite };
}

type Spec = Partial<RegistryModel> & Pick<RegistryModel, "id" | "label" | "status" | "source">;
function model(spec: Spec): RegistryModel {
  return {
    endsOn: null,
    replacement: null,
    offered: false,
    tier: null,
    tools: true,
    streaming: true,
    prices: [],
    ...spec,
  };
}
/** A model that no longer answers: kept so a saved id still finds its replacement. */
function retired(id: string, label: string, endedOn: string, replacement: string, source: string, note?: string): RegistryModel {
  return model({ id, label, status: "retired", endsOn: endedOn, replacement, tools: false, streaming: false, source, note });
}

/** Why a 5.x Claude model is offered but is not the default (see THE DEFAULT above). */
const ALWAYS_THINKS =
  "Always thinks before it answers, and has not been called through this app yet, so it is offered but is not the default.";
const NOT_CALLED_YET = "Has not been called through this app yet, so it is offered but is not the default.";

/**
 * Anthropic, Messages API. 5-minute cache writes cost 1.25x input. Claude
 * Haiku 5.5 is priced by prompt length (above 100K tokens: $0.50 / $2.50).
 * Retirement dates Anthropic prints as "not sooner than" are earliest dates,
 * not schedules, so a legacy model here has no endsOn.
 */
const ANTHROPIC: ProviderModels = {
  provider: "anthropic",
  vendor: "Anthropic",
  surface: "Anthropic's Messages API",
  probeModel: "claude-sonnet-4-6",
  probeNote:
    "The default model: it answers a one-token test without thinking first (Sonnet 5.5, Opus 5.5 and Fable 5.1 always think), and the test costs a fraction of a cent.",
  models: [
    model({
      id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", status: "current", offered: true,
      prices: [price(NEW, 2.0, 10.0, 0.1, 2.5)], source: `${ANTHROPIC_MODELS_URL} ; ${ANTHROPIC_PRICING_URL}`, note: ALWAYS_THINKS,
    }),
    model({
      id: "claude-haiku-5-5", label: "Claude Haiku 5.5", status: "current", offered: true, tier: "fast",
      prices: [price(NEW, 0.1, 0.5, 0.01, 0.125), price(NEW, 0.5, 2.5, 0.05, 0.625, 100_000)],
      source: `${ANTHROPIC_MODELS_URL} ; ${ANTHROPIC_PRICING_URL}`, note: NOT_CALLED_YET,
    }),
    model({
      id: "claude-opus-5-5", label: "Claude Opus 5.5", status: "current", offered: true,
      prices: [price(NEW, 4.0, 20.0, 0.2, 5.0)], source: `${ANTHROPIC_MODELS_URL} ; ${ANTHROPIC_PRICING_URL}`, note: ALWAYS_THINKS,
    }),
    model({
      id: "claude-fable-5-1", label: "Claude Fable 5.1", status: "current", offered: true, tier: "deep",
      prices: [price(NEW, 10.0, 50.0, 0.25, 12.5)], source: `${ANTHROPIC_MODELS_URL} ; ${ANTHROPIC_PRICING_URL}`, note: ALWAYS_THINKS,
    }),
    model({
      id: "claude-mythos-5-1", label: "Claude Mythos 5.1", status: "access_limited", limitedTo: "verified", replacement: "claude-fable-5-1",
      source: ANTHROPIC_MODELS_URL, note: "Anthropic serves it only to verified accounts (Cyber Verification Program).",
    }),
    model({ id: "claude-fable-5", label: "Claude Fable 5", status: "legacy", replacement: "claude-fable-5-1", source: ANTHROPIC_MODELS_URL }),
    model({ id: "claude-opus-5", label: "Claude Opus 5", status: "legacy", replacement: "claude-opus-5-5", source: ANTHROPIC_MODELS_URL }),
    model({ id: "claude-sonnet-5", label: "Claude Sonnet 5", status: "legacy", replacement: "claude-sonnet-5-5", source: ANTHROPIC_MODELS_URL }),
    model({ id: "claude-opus-4-8", label: "Claude Opus 4.8", status: "legacy", replacement: "claude-opus-5-5", source: ANTHROPIC_MODELS_URL }),
    model({
      id: "claude-opus-4-7", label: "Claude Opus 4.7", status: "legacy", replacement: "claude-opus-5-5",
      prices: [price(SEEDED, 5.0, 25.0, 0.5, 6.25)], source: `${ANTHROPIC_MODELS_URL} ; ${ANTHROPIC_PRICING_URL}`,
    }),
    model({ id: "claude-opus-4-6", label: "Claude Opus 4.6", status: "legacy", replacement: "claude-opus-5-5", source: ANTHROPIC_MODELS_URL }),
    model({
      id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", status: "legacy", offered: true, tier: "balanced", replacement: "claude-sonnet-5-5",
      prices: [price(SEEDED, 3.0, 15.0, 0.3, 3.75)], source: `${ANTHROPIC_MODELS_URL} ; ${ANTHROPIC_PRICING_URL}`,
      note: "The default: this app's Anthropic default since 2026-05 (it thinks only when asked to). Anthropic retires it no sooner than 2027-02-17.",
    }),
    model({ id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5", status: "legacy", replacement: "claude-opus-5-5", source: ANTHROPIC_MODELS_URL }),
    model({ id: "claude-opus-4-5", label: "Claude Opus 4.5", status: "legacy", replacement: "claude-opus-5-5", source: ANTHROPIC_MODELS_URL, note: "An alias of claude-opus-4-5-20251101." }),
    model({
      id: "claude-haiku-4-5", label: "Claude Haiku 4.5", status: "legacy", replacement: "claude-haiku-5-5",
      prices: [price(SEEDED, 1.0, 5.0, 0.1, 1.25)], source: `${ANTHROPIC_MODELS_URL} ; ${ANTHROPIC_PRICING_URL}`,
      note: "An alias of claude-haiku-4-5-20251001.",
    }),
    model({ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", status: "legacy", replacement: "claude-haiku-5-5", source: ANTHROPIC_MODELS_URL }),
    model({
      id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", status: "deprecated", endsOn: "2026-11-30",
      replacement: "claude-sonnet-5-5", source: ANTHROPIC_LIFECYCLE_URL, note: "Deprecated 2026-09-30: closed to new accounts.",
    }),
    model({
      id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", status: "deprecated", endsOn: "2026-11-30",
      replacement: "claude-sonnet-5-5", source: ANTHROPIC_LIFECYCLE_URL, note: "An alias of claude-sonnet-4-5-20250929.",
    }),
    retired("claude-opus-4-1-20250805", "Claude Opus 4.1", "2026-08-05", "claude-opus-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-opus-4-20250514", "Claude Opus 4", "2026-06-15", "claude-opus-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-sonnet-4-20250514", "Claude Sonnet 4", "2026-06-15", "claude-sonnet-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-3-7-sonnet-20250219", "Claude Sonnet 3.7", "2026-02-19", "claude-sonnet-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-3-5-haiku-20241022", "Claude Haiku 3.5", "2026-02-19", "claude-haiku-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-3-haiku-20240307", "Claude Haiku 3", "2026-04-20", "claude-haiku-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-3-5-sonnet-20241022", "Claude Sonnet 3.5", "2025-10-28", "claude-sonnet-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-3-5-sonnet-20240620", "Claude Sonnet 3.5", "2025-10-28", "claude-sonnet-5-5", ANTHROPIC_LIFECYCLE_URL),
    retired("claude-3-opus-20240229", "Claude Opus 3", "2026-01-05", "claude-opus-5-5", ANTHROPIC_LIFECYCLE_URL),
  ],
};

/**
 * OpenAI, Chat Completions. Only models whose tool calls work there WITHOUT a
 * reasoning_effort parameter are offered, so the offered list is the GPT-5.x
 * line (legacy, still answering, no end date). Replacements of retired and
 * deprecated ids point at that line too, for the same reason; the GPT-6 ids
 * OpenAI itself names are kept in the notes. Prompts above 272K input tokens
 * cost 2x input and cache and 1.5x output on the models the pricing page says
 * so for. The page lists no cache-write rate.
 */
const GPT6_NOT_OFFERED =
  "Not offered here yet: its tool calls need OpenAI's Responses API, and this app talks to Chat Completions.";
const OPENAI: ProviderModels = {
  provider: "openai",
  vendor: "OpenAI",
  surface: "OpenAI's Chat Completions API",
  probeModel: "gpt-5.4-mini",
  probeNote: "Answers a one-token test with no reasoning step; GPT-6 Luna would need reasoning_effort none.",
  note: "GPT-6 models are listed but not offered: their tool calls need OpenAI's Responses API, which this app does not use yet.",
  models: [
    model({
      id: "gpt-5.6-terra", label: "GPT-5.6 Terra", status: "legacy", offered: true, tier: "balanced", replacement: "gpt-6.1-sol",
      prices: [price(NEW, 2.0, 12.0, 0.2, null), price(NEW, 4.0, 18.0, 0.4, null, 272_000)],
      source: `${OPENAI_MODELS_URL} ; ${OPENAI_PRICING_URL}`,
      note: "Superseded by GPT-6.1 Sol, whose tool calls need the Responses API.",
    }),
    model({
      id: "gpt-5.6-luna", label: "GPT-5.6 Luna", status: "legacy", offered: true, tier: "fast", replacement: "gpt-6-luna",
      prices: [price(NEW, 0.2, 1.2, 0.02, null), price(NEW, 0.4, 1.8, 0.04, null, 272_000)],
      source: `${OPENAI_MODELS_URL} ; ${OPENAI_PRICING_URL}`,
      note: "Superseded by GPT-6 Luna, which takes tool calls on Chat Completions only with reasoning_effort none.",
    }),
    model({
      id: "gpt-5.5", label: "GPT-5.5", status: "legacy", offered: true, tier: "deep", replacement: "gpt-6.1-sol",
      prices: [price(NEW, 5.0, 30.0, 0.5, null)], source: `${OPENAI_MODELS_URL} ; ${OPENAI_PRICING_URL}`,
      note: "Superseded by GPT-6.1 Sol, whose tool calls need the Responses API.",
    }),
    model({ id: "gpt-6-luna", label: "GPT-6 Luna", status: "current", tools: false, source: OPENAI_GPT6_URL, note: GPT6_NOT_OFFERED }),
    model({ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", status: "current", tools: false, source: OPENAI_GPT6_URL, note: GPT6_NOT_OFFERED }),
    model({ id: "gpt-6-astra", label: "GPT-6 Astra", status: "current", tools: false, source: OPENAI_GPT6_URL, note: GPT6_NOT_OFFERED }),
    model({ id: "gpt-6-sol", label: "GPT-6 Sol", status: "current", tools: false, source: OPENAI_GPT6_URL, note: GPT6_NOT_OFFERED }),
    model({ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", status: "legacy", replacement: "gpt-5.6-terra", source: OPENAI_MODELS_URL }),
    model({
      id: "gpt-5.4", label: "GPT-5.4", status: "legacy", replacement: "gpt-5.6-terra",
      prices: [price(SEEDED, 2.5, 15.0, 0.25, null), price(SEEDED, 5.0, 22.5, 0.5, null, 272_000)],
      source: `${OPENAI_MODELS_URL} ; ${OPENAI_PRICING_URL}`,
    }),
    model({
      id: "gpt-5.4-mini", label: "GPT-5.4 mini", status: "legacy", replacement: "gpt-5.6-luna",
      prices: [price(SEEDED, 0.75, 4.5, 0.075, null)], source: `${OPENAI_MODELS_URL} ; ${OPENAI_PRICING_URL}`,
    }),
    model({
      id: "gpt-5.2", label: "GPT-5.2", status: "legacy", replacement: "gpt-5.6-terra",
      prices: [price(SEEDED, 1.75, 14.0, 0.175, null)], source: `${OPENAI_MODELS_URL} ; ${OPENAI_PRICING_URL}`,
    }),
    model({
      id: "gpt-5.3-codex", label: "GPT-5.3 Codex", status: "deprecated", endsOn: "2027-04-01", replacement: "gpt-5.6-terra",
      prices: [price(SEEDED, 1.75, 14.0, 0.175, null)], source: `${OPENAI_LIFECYCLE_URL} ; ${OPENAI_PRICING_URL}`,
      note: "OpenAI names GPT-6 Sol as its replacement; GPT-5.6 Terra is the closest model whose tool calls work here.",
    }),
    model({ id: "gpt-5.4-nano", label: "GPT-5.4 nano", status: "deprecated", endsOn: "2027-04-01", replacement: "gpt-5.6-luna", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-5.1", label: "GPT-5.1", status: "deprecated", endsOn: "2027-04-01", replacement: "gpt-5.6-terra", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-5-2025-08-07", label: "GPT-5", status: "deprecated", endsOn: "2026-12-11", replacement: "gpt-5.6-terra", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-5-mini-2025-08-07", label: "GPT-5 mini", status: "deprecated", endsOn: "2026-12-11", replacement: "gpt-5.6-luna", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-4-0613", label: "GPT-4", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-terra", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-4", label: "GPT-4", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-terra", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-4-turbo", label: "GPT-4 Turbo", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-terra", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-4-1106-preview", label: "GPT-4 Turbo preview", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-terra", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-4o-2024-05-13", label: "GPT-4o", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-terra", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-4.1-nano", label: "GPT-4.1 nano", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-luna", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "o1", label: "o1", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.5", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "o1-pro", label: "o1 pro", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.5", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "o3-mini", label: "o3-mini", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-luna", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "o4-mini", label: "o4-mini", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-luna", source: OPENAI_LIFECYCLE_URL }),
    model({ id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", status: "deprecated", endsOn: "2026-10-23", replacement: "gpt-5.6-luna", source: OPENAI_LIFECYCLE_URL }),
    retired("gpt-5.2-codex", "GPT-5.2 Codex", "2026-07-23", "gpt-5.6-terra", OPENAI_LIFECYCLE_URL),
    retired("gpt-5.1-codex", "GPT-5.1 Codex", "2026-07-23", "gpt-5.6-terra", OPENAI_LIFECYCLE_URL),
    retired("gpt-5.2-chat-latest", "GPT-5.2 chat", "2026-08-10", "gpt-5.6-terra", OPENAI_LIFECYCLE_URL),
    retired("gpt-5.3-chat-latest", "GPT-5.3 chat", "2026-08-10", "gpt-5.6-terra", OPENAI_LIFECYCLE_URL),
  ],
};

/**
 * Google, generateContent (v1beta). The 2.5 models are not deprecated on the
 * Gemini API, but since 2026-09-18 Google serves them only to projects that
 * used them before: a new project's call fails 404 "no longer available to new
 * users". The 3.6 to 3.8 Flash models are at an introductory price through
 * 2026-12-31 and double on 2027-01-01. Above 200K prompt tokens 3.1 Pro (and
 * 2.5 Pro) cost more. The context-caching rate is the cache-read rate; the page
 * lists storage per hour, not a per-token write rate.
 */
const GOOGLE: ProviderModels = {
  provider: "google",
  vendor: "Google",
  surface: "the Gemini API's generateContent (v1beta)",
  probeModel: "gemini-3.5-flash-lite",
  probeNote: "The Flash-Lite model Google names for new projects: every project can call it, so a good key never fails its test on access.",
  models: [
    model({
      id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", status: "current", offered: true, tier: "balanced",
      prices: [price(NEW, 0.75, 3.75, 0.075, null), price("2027-01-01", 1.5, 7.5, 0.15, null)],
      source: `${GOOGLE_MODELS_URL} ; ${GOOGLE_PRICING_URL}`,
    }),
    model({
      id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", status: "current", offered: true, tier: "fast",
      prices: [price(NEW, 0.3, 2.5, 0.03, null)], source: `${GOOGLE_MODELS_URL} ; ${GOOGLE_PRICING_URL}`,
    }),
    model({
      id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", status: "preview", offered: true, tier: "deep",
      replacement: "gemini-3.8-flash",
      prices: [price(NEW, 2.0, 12.0, 0.2, null), price(NEW, 4.0, 18.0, 0.4, null, 200_000)],
      source: `${GOOGLE_MODELS_URL} ; ${GOOGLE_PRICING_URL}`,
      note: "A preview: Google may withdraw it with two weeks' notice. Paid tier only.",
    }),
    model({ id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", status: "current", source: GOOGLE_MODELS_URL }),
    model({ id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", status: "current", source: GOOGLE_MODELS_URL }),
    model({ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", status: "legacy", replacement: "gemini-3.8-flash", source: GOOGLE_MODELS_URL }),
    model({ id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", status: "legacy", replacement: "gemini-3.6-flash", source: GOOGLE_LIFECYCLE_URL }),
    model({ id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", status: "deprecated", endsOn: "2027-05-07", replacement: "gemini-3.5-flash-lite", source: GOOGLE_LIFECYCLE_URL }),
    model({
      id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", status: "access_limited", replacement: "gemini-3.8-flash",
      prices: [price(SEEDED, 1.25, 10.0, 0.125, null), price(SEEDED, 2.5, 15.0, 0.25, null, 200_000)],
      source: `${GOOGLE_ACCESS_URL} ; ${GOOGLE_PRICING_URL}`,
      note: "Google names Gemini 3.8 Flash and 3.5 Flash-Lite for new projects; its Pro-class successor is Gemini 3.1 Pro, a preview.",
    }),
    model({
      id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", status: "access_limited", replacement: "gemini-3.5-flash-lite",
      prices: [price(SEEDED, 0.3, 2.5, 0.03, null)], source: `${GOOGLE_ACCESS_URL} ; ${GOOGLE_PRICING_URL}`,
      note: "Gemini 3.5 Flash-Lite is the same price.",
    }),
    model({ id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", status: "access_limited", replacement: "gemini-3.5-flash-lite", source: GOOGLE_ACCESS_URL }),
    retired("gemini-2.0-flash", "Gemini 2.0 Flash", "2026-06-01", "gemini-3.8-flash", GOOGLE_LIFECYCLE_URL),
    retired("gemini-2.0-flash-lite", "Gemini 2.0 Flash-Lite", "2026-06-01", "gemini-3.5-flash-lite", GOOGLE_LIFECYCLE_URL),
    retired("gemini-3-pro-preview", "Gemini 3 Pro (preview)", "2026-03-09", "gemini-3.1-pro-preview", GOOGLE_LIFECYCLE_URL),
    retired("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash-Lite (preview)", "2026-05-25", "gemini-3.5-flash-lite", GOOGLE_LIFECYCLE_URL),
  ],
};

/**
 * OpenRouter, one key for every vendor. Prices are its catalog's (the top
 * provider's list price, per token, here per million); OpenRouter also reports
 * each call's own cost, which is what the ledger records when it does.
 * endsOn is the catalog's expiration_date: "the date after which the model may
 * be removed". Google's 2.5 models carry 2026-10-20.
 */
const OPENROUTER: ProviderModels = {
  provider: "openrouter",
  vendor: "OpenRouter",
  surface: "OpenRouter's OpenAI-compatible chat completions",
  probeModel: "meta-llama/llama-3.3-70b-instruct",
  probeNote: "Cheap, still served, and answers a 16-token test (OpenRouter's floor for some providers).",
  note: "OpenAI's GPT-6 models are not offered through OpenRouter yet: how OpenRouter carries their tool calls is not verified.",
  models: [
    model({
      id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", status: "legacy", offered: true, tier: "balanced",
      replacement: "anthropic/claude-sonnet-5.5", prices: [price(NEW, 3.0, 15.0, 0.3, null)], source: OPENROUTER_CATALOG_URL,
      note: "The default: this app's OpenRouter default since 2026-05 (see THE DEFAULT above).",
    }),
    model({
      id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", status: "current", offered: true,
      prices: [price(NEW, 2.0, 10.0, 0.1, null)], source: OPENROUTER_CATALOG_URL, note: ALWAYS_THINKS,
    }),
    model({
      id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", status: "current", offered: true, tier: "fast",
      prices: [price(NEW, 0.1, 0.5, 0.01, null)], source: OPENROUTER_CATALOG_URL, note: NOT_CALLED_YET,
    }),
    model({
      id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", status: "current", offered: true, tier: "deep",
      prices: [price(NEW, 4.0, 20.0, 0.2, null)], source: OPENROUTER_CATALOG_URL, note: ALWAYS_THINKS,
    }),
    model({
      id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1", status: "current", offered: true,
      prices: [price(NEW, 10.0, 50.0, 0.25, null)], source: OPENROUTER_CATALOG_URL, note: ALWAYS_THINKS,
    }),
    model({
      id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", status: "current", offered: true,
      prices: [price(NEW, 0.75, 3.75, 0.075, null)], source: OPENROUTER_CATALOG_URL,
      note: "OpenRouter lists Google's introductory price; Google doubles it on 2027-01-01.",
    }),
    model({
      id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", status: "current", offered: true,
      prices: [price(NEW, 0.3, 2.5, 0.03, null)], source: OPENROUTER_CATALOG_URL,
    }),
    model({
      id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", status: "preview", offered: true,
      replacement: "google/gemini-3.8-flash", prices: [price(NEW, 2.0, 12.0, 0.2, null)], source: OPENROUTER_CATALOG_URL,
    }),
    model({
      id: "openai/gpt-5.4", label: "GPT-5.4", status: "legacy", offered: true, replacement: "openai/gpt-6.1-sol",
      prices: [price(NEW, 2.5, 15.0, 0.25, null)], source: OPENROUTER_CATALOG_URL,
    }),
    model({
      id: "openai/gpt-5.4-mini", label: "GPT-5.4 mini", status: "legacy", offered: true, replacement: "openai/gpt-6-luna",
      prices: [price(NEW, 0.75, 4.5, 0.075, null)], source: OPENROUTER_CATALOG_URL,
    }),
    model({
      id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", status: "current", offered: true,
      prices: [price(NEW, 0.1875, 0.6525, 0.05, null)], source: OPENROUTER_CATALOG_URL,
    }),
    model({ id: "openai/gpt-6-luna", label: "GPT-6 Luna", status: "current", tools: false, source: OPENROUTER_CATALOG_URL, note: GPT6_NOT_OFFERED }),
    model({ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", status: "current", tools: false, source: OPENROUTER_CATALOG_URL, note: GPT6_NOT_OFFERED }),
    model({ id: "openai/gpt-6-astra", label: "GPT-6 Astra", status: "current", tools: false, source: OPENROUTER_CATALOG_URL, note: GPT6_NOT_OFFERED }),
    model({ id: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7", status: "legacy", replacement: "anthropic/claude-opus-5.5", source: OPENROUTER_CATALOG_URL }),
    model({
      // The live catalog read again on 2026-10-08 evening (PR #555 review): $0.22 / $0.50, cache read $0.11.
      id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", status: "legacy", replacement: "meta-llama/llama-4-maverick",
      prices: [price(NEW, 0.22, 0.5, 0.11, null)], source: OPENROUTER_CATALOG_URL,
    }),
    model({
      id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", status: "deprecated", endsOn: "2026-10-20",
      replacement: "google/gemini-3.8-flash", source: OPENROUTER_CATALOG_URL,
      note: "Gemini 3.8 Flash, the same model Google names for new projects; the Pro-class successor, Gemini 3.1 Pro, is a preview.",
    }),
    model({
      id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", status: "deprecated", endsOn: "2026-10-20",
      replacement: "google/gemini-3.5-flash-lite", source: OPENROUTER_CATALOG_URL, note: "Gemini 3.5 Flash-Lite is the same price.",
    }),
    model({
      id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", status: "deprecated", endsOn: "2026-10-20",
      replacement: "google/gemini-3.5-flash-lite", source: OPENROUTER_CATALOG_URL,
    }),
  ],
};

export const MODEL_REGISTRY: Readonly<Record<RegistryProvider, ProviderModels>> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  google: GOOGLE,
  openrouter: OPENROUTER,
};

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

export function isRegistryProvider(p: unknown): p is RegistryProvider {
  return typeof p === "string" && (REGISTRY_PROVIDERS as readonly string[]).includes(p);
}

/** The registry's entry for a saved model, or null (another provider, or an id it does not know). */
export function modelInfo(provider: string, id: string): RegistryModel | null {
  if (!isRegistryProvider(provider)) return null;
  const want = String(id || "").trim();
  return MODEL_REGISTRY[provider].models.find((m) => m.id === want) ?? null;
}

const TIER_ORDER: Record<string, number> = { balanced: 0, fast: 1, deep: 2 };

/** The models a picker offers, the provider's default (balanced) first. */
export function offeredModels(provider: RegistryProvider): RegistryModel[] {
  const offered = MODEL_REGISTRY[provider].models.filter((m) => m.offered);
  return [...offered].sort((a, b) => (TIER_ORDER[a.tier ?? ""] ?? 3) - (TIER_ORDER[b.tier ?? ""] ?? 3));
}

/** The model a new connection to this provider starts on: its balanced tier. */
export function defaultModelFor(provider: RegistryProvider): string {
  return offeredModels(provider)[0].id;
}

/** A picker's label: the name, and its tier when it has one. */
export function pickerLabel(m: RegistryModel): string {
  return m.tier ? `${m.label} (${m.tier})` : m.label;
}

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return dayOf(d);
}

/** Why a model cannot be used now. */
export type GoneReason = "retired" | "access_limited" | "expired";

export type ModelVerdict =
  | { kind: "usable"; model: RegistryModel; endsOn: string | null }
  | { kind: "gone"; model: RegistryModel; reason: GoneReason }
  | { kind: "unknown" };

/**
 * Can this saved model be sent now? Retired and access-limited models cannot;
 * any other model cannot from its end day on (a deprecated model's shutdown,
 * OpenRouter's expiration). A model this file does not know is "unknown":
 * nobody here can say, so it is neither replaced nor called broken.
 */
export function modelVerdict(provider: string, id: string, now: Date = new Date()): ModelVerdict {
  const m = modelInfo(provider, id);
  if (!m) return { kind: "unknown" };
  if (m.status === "retired") return { kind: "gone", model: m, reason: "retired" };
  if (m.status === "access_limited") return { kind: "gone", model: m, reason: "access_limited" };
  if (m.endsOn && dayOf(now) >= m.endsOn) return { kind: "gone", model: m, reason: "expired" };
  return { kind: "usable", model: m, endsOn: m.endsOn };
}

/**
 * The first usable model down a replacement chain, on the same provider, that
 * takes tool calls through this app's request, or null when the chain ends
 * nowhere usable (a cycle, or an id this file does not know). A model with no
 * tool calls here (OpenAI's GPT-6 on Chat Completions) is passed over: a swap
 * to it would fail every tool-using turn, and a "pick X instead" naming it
 * would name a model Settings refuses (CodeRabbit on #555).
 * tests/model-registry.checks.ts proves every chain ends.
 */
export function usableReplacement(provider: string, id: string, now: Date = new Date(), horizonDays = 0): RegistryModel | null {
  let current = modelInfo(provider, id);
  const seen = new Set<string>();
  while (current && current.replacement && !seen.has(current.id)) {
    seen.add(current.id);
    const next = modelInfo(provider, current.replacement);
    if (!next) return null;
    const lasting = horizonDays > 0 ? endsWithin(provider, next.id, horizonDays, now) === null : modelVerdict(provider, next.id, now).kind === "usable";
    if (lasting && next.tools) return next;
    current = next;
  }
  return null;
}

/** What a call sends instead of the saved model, and why. */
export type ModelSwap = {
  provider: RegistryProvider;
  savedModel: string;
  savedLabel: string;
  model: string;
  label: string;
  reason: GoneReason;
  /** The saved model's end day, for "expired". */
  endedOn: string | null;
  /** ai_usage_events.fallback_reason: a code naming the reason and the saved id. */
  fallbackReason: string;
};

export type ModelForCall = { model: string; swap: ModelSwap | null };

/**
 * The model a request actually sends for a saved `model`. Unchanged unless the
 * registry says the saved model cannot be used now; then the first usable
 * replacement ON THE SAME PROVIDER. The key is the caller's and never changes,
 * and nothing here ever picks another provider. A model with no usable
 * replacement is sent as saved (its failure is then shown honestly, by name).
 */
export function resolveModelForCall(provider: string, model: string, now: Date = new Date()): ModelForCall {
  const verdict = modelVerdict(provider, model, now);
  if (verdict.kind !== "gone" || !isRegistryProvider(provider)) return { model, swap: null };
  const next = usableReplacement(provider, verdict.model.id, now);
  if (!next) return { model, swap: null };
  return {
    model: next.id,
    swap: {
      provider,
      savedModel: verdict.model.id,
      savedLabel: verdict.model.label,
      model: next.id,
      label: next.label,
      reason: verdict.reason,
      endedOn: verdict.model.endsOn,
      fallbackReason: `model_${verdict.reason}:${verdict.model.id}`,
    },
  };
}

/**
 * A meter that records `swap` on every call it opens
 * (ai_usage_events.fallback_reason). The same meter when nothing was swapped.
 */
export function meterWithSwap(meter: ModelCallMeter, swap: ModelSwap | null): ModelCallMeter {
  if (!swap) return meter;
  return {
    context: meter.context,
    totals: () => meter.totals(),
    begin: (call: BeginCall): Promise<ModelCall> => meter.begin({ ...call, fallbackReason: call.fallbackReason ?? swap.fallbackReason }),
  };
}

/**
 * Resolve a call's model and meter together: the request sends the returned
 * model, and the returned meter records why it is not the saved one. Calling
 * it again on its own result changes nothing, so a turn resolved early (the
 * department channel, to show the right model) and again where the request is
 * built records the swap exactly once.
 */
export function resolveCall<M extends ModelCallMeter>(
  provider: string,
  model: string,
  meter: M,
  now: Date = new Date(),
): { model: string; meter: ModelCallMeter | M; swap: ModelSwap | null } {
  const picked = resolveModelForCall(provider, model, now);
  return { model: picked.model, meter: meterWithSwap(meter, picked.swap), swap: picked.swap };
}

// ---------------------------------------------------------------------------
// Saving one
// ---------------------------------------------------------------------------

/** A model that is gone now, or ends within `days`: no save may put one back. */
export function endsWithin(provider: string, id: string, days: number, now: Date = new Date()): { model: RegistryModel; endsOn: string | null; reason: GoneReason | "ending" } | null {
  const v = modelVerdict(provider, id, now);
  if (v.kind === "gone") return { model: v.model, endsOn: v.model.endsOn, reason: v.reason };
  if (v.kind === "usable" && v.endsOn && v.endsOn <= addDays(dayOf(now), days)) return { model: v.model, endsOn: v.endsOn, reason: "ending" };
  return null;
}

/**
 * Whether a save may store this model. A model that is gone, or ends within
 * REGISTRY_HORIZON_DAYS, may not: the sentence says why and what to pick. Nor
 * may a model whose tool calls do not work through this app (OpenAI's GPT-6 on
 * Chat Completions): it answers a key test, so nothing else would stop a
 * direct request from saving it, and every tool-using chat on it would then
 * fail (PR #555 review). The callers let a row keep a model it ALREADY holds
 * through an edit that does not change it. An id this file does not know may
 * be saved where the caller allows that (it is shown as itself, with a note);
 * `known` says whether it was known.
 */
export function saveCheck(provider: string, id: string, now: Date = new Date()): { ok: true; known: boolean } | { ok: false; message: string } {
  const ending = endsWithin(provider, id, REGISTRY_HORIZON_DAYS, now);
  if (!ending) {
    const known = modelInfo(provider, id);
    if (known && !known.tools && isRegistryProvider(provider)) {
      const fallback = modelInfo(provider, defaultModelFor(provider));
      const pick = fallback ? ` Pick ${fallback.label} or another listed model.` : " Pick another listed model.";
      return { ok: false, message: `${limitedSentence(provider, known)}${pick}` };
    }
    return { ok: true, known: known !== null };
  }
  const vendor = isRegistryProvider(provider) ? MODEL_REGISTRY[provider].vendor : "The provider";
  const next = usableReplacement(provider, ending.model.id, now);
  const pick = next ? ` Pick ${next.label} or another listed model.` : " Pick another listed model.";
  return { ok: false, message: `${goneClause(vendor, ending.model, ending.reason)}.${pick}` };
}

/** Why a listed model whose tool calls do not work through this app is not offered, as one sentence. */
function limitedSentence(provider: RegistryProvider, m: RegistryModel): string {
  return provider === "openrouter"
    ? `${m.label} answers chats, but its tool calls through OpenRouter are not verified yet, so this app does not offer it.`
    : `${m.label} answers chats, but its tool calls need ${MODEL_REGISTRY[provider].vendor}'s newer Responses API, which this app does not use yet.`;
}

/** "<Vendor> no longer offers <Model> to new accounts", without the full stop. */
function goneClause(vendor: string, m: RegistryModel, reason: GoneReason | "ending"): string {
  if (reason === "access_limited") {
    return m.limitedTo === "verified" ? `${vendor} offers ${m.label} only to verified accounts` : `${vendor} no longer offers ${m.label} to new accounts`;
  }
  if (reason === "retired") return `${vendor} retired ${m.label}${m.endsOn ? ` on ${m.endsOn}` : ""}`;
  if (reason === "expired") return `${vendor} stopped offering ${m.label}${m.endsOn ? ` on ${m.endsOn}` : ""}`;
  return `${vendor} stops offering ${m.label} on ${m.endsOn}`;
}

// ---------------------------------------------------------------------------
// Telling the owner
// ---------------------------------------------------------------------------

/** Who a saved model serves, for the note's last words. */
export type NoteAudience = "departments" | "agent" | "you";
const WHO: Record<NoteAudience, string> = {
  departments: "your departments now use",
  agent: "this agent now uses",
  you: "your chats now use",
};
const WHO_LATER: Record<NoteAudience, string> = {
  departments: "your departments will move to",
  agent: "this agent will move to",
  you: "your chats will move to",
};

export type ModelNote = {
  /**
   * gone: calls already send the replacement. ending: they will from its end
   * day. older: still works, a newer one exists. limited: answers chats, but
   * this app does not offer it (its tool calls need another API). unknown: not
   * on the list.
   */
  kind: "gone" | "ending" | "older" | "limited" | "unknown";
  sentence: string;
};

/**
 * The one plain sentence Settings shows next to a saved model, or null when
 * there is nothing to say (a model the pickers offer, or another current one).
 * It says what really happens: a gone model's calls already use the
 * replacement resolveModelForCall picks.
 */
export function modelNote(provider: string, id: string, opts: { audience: NoteAudience; now?: Date }): ModelNote | null {
  if (!isRegistryProvider(provider)) return null;
  const now = opts.now ?? new Date();
  const vendor = MODEL_REGISTRY[provider].vendor;
  const v = modelVerdict(provider, id, now);
  if (v.kind === "unknown") {
    if (!String(id || "").trim()) return null;
    return {
      kind: "unknown",
      sentence: `${id} is not on our list of ${vendor} models, so we can't say whether ${vendor} still offers it. Pick a listed model to be sure.`,
    };
  }
  const next = usableReplacement(provider, v.model.id, now);
  if (v.kind === "gone") {
    const tail = next ? `; ${WHO[opts.audience]} ${next.label}.` : ". Pick another listed model.";
    return { kind: "gone", sentence: `${goneClause(vendor, v.model, v.reason)}${tail}` };
  }
  if (v.endsOn && v.endsOn <= addDays(dayOf(now), REGISTRY_HORIZON_DAYS)) {
    const tail = next ? `. Pick a newer model, or ${WHO_LATER[opts.audience]} ${next.label} then.` : ". Pick a newer model.";
    return { kind: "ending", sentence: `${goneClause(vendor, v.model, "ending")}${tail}` };
  }
  if (v.model.offered) return null;
  if (!v.model.tools) return { kind: "limited", sentence: limitedSentence(provider, v.model) };
  if (v.model.status === "current" || v.model.status === "preview") return null;
  if (v.model.status === "deprecated" && v.endsOn) {
    return { kind: "older", sentence: `${goneClause(vendor, v.model, "ending")}.${next ? ` ${next.label} is its replacement.` : ""}` };
  }
  return { kind: "older", sentence: `${v.model.label} is an older model that still works.${next ? ` ${next.label} is its current replacement.` : ""}` };
}

/** One option of a model picker. */
export type ModelChoice = { id: string; label: string; offered: boolean };

/**
 * A picker's options for a saved value: the offered models, plus the saved
 * value itself when it is not one of them, labelled honestly. A picker never
 * shows an option the saved value does not match (the browser would draw the
 * first option over it, and a save would put it back), and never relabels the
 * saved value as something it is not.
 */
export function modelChoices(provider: RegistryProvider, saved: string | null | undefined, now: Date = new Date()): ModelChoice[] {
  const choices: ModelChoice[] = offeredModels(provider).map((m) => ({ id: m.id, label: pickerLabel(m), offered: true }));
  const value = String(saved || "").trim();
  if (!value || choices.some((c) => c.id === value)) return choices;
  const known = modelInfo(provider, value);
  const v = modelVerdict(provider, value, now);
  const state = v.kind === "gone" ? "saved, no longer offered" : v.kind === "unknown" ? "saved, not on our list" : "saved";
  return [{ id: value, label: `${known ? known.label : value} (${state})`, offered: false }, ...choices];
}

/**
 * What the failure copy names when a provider says a model was not found
 * (lib/os/channel/outcome.ts takes it as data, so that file stays import-free):
 * the model's name, who offers it, and the model to pick instead.
 */
export function modelFactsForCopy(provider: string, id: string): { label: string; vendor: string | null; suggestion: string | null } {
  const known = modelInfo(provider, id);
  const label = known ? `${known.label} (${known.id})` : String(id || "").trim() || "this model";
  if (!isRegistryProvider(provider)) return { label, vendor: null, suggestion: null };
  const next = known ? usableReplacement(provider, known.id) : null;
  const fallback = modelInfo(provider, defaultModelFor(provider));
  const suggestion = next?.label ?? (fallback && fallback.id !== known?.id ? fallback.label : null);
  return { label, vendor: MODEL_REGISTRY[provider].vendor, suggestion };
}
