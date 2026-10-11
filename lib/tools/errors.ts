/**
 * lib/tools/errors.ts - the one plain line a failed tool run shows, per code.
 *
 * PURE (no server imports): the jobs route turns a stored code into its line
 * when it answers, so the wording lives here and nowhere else, and a line
 * changed here reaches every old run too.
 *
 * Runner codes come from the computer that ran the job (the video downloader on
 * OASIS's PC). The lines are the extractor's own hints with the command-line
 * advice removed. The runner never sends its error output: only a code. A code
 * this file does not know is stored as `unknown`.
 *
 * Founders may see the code in small text next to the line; a client workspace
 * never sees a runner tool at all.
 */
import {
  AI_BUDGET_EXHAUSTED,
  AI_BUDGET_SENTENCES,
  AI_BUDGET_UNPRICED_MODEL,
  AI_USAGE_UNAVAILABLE,
  AI_USAGE_UNAVAILABLE_SENTENCE,
} from "@/lib/ai/usage-codes";

const RUNNER_FAILED = "The download failed on the connected computer.";

/** Codes the runner may send (POST /api/internal/tools/fail), with their lines. */
export const RUNNER_ERROR_LINES: Readonly<Record<string, string>> = {
  unsupported_url: "That link can't be downloaded. Paste the post's own link.",
  private: "The post or account is private.",
  login_required: "This post needs a signed-in account to download.",
  rate_limited: "The platform is limiting downloads right now. Try again later.",
  http_403: "The platform refused the download.",
  geo_blocked: "The post is region-locked.",
  unavailable: "The post was removed or never existed.",
  no_video: "The download had no video in it.",
  too_large: "The video is larger than 95 MB.",
  timeout: "The download took too long and was stopped.",
  cert_error: RUNNER_FAILED,
  ffmpeg_missing: RUNNER_FAILED,
  upload_failed: RUNNER_FAILED,
  upload_tls_error: RUNNER_FAILED,
  upload_mismatch: RUNNER_FAILED,
  unsupported_tool: RUNNER_FAILED,
  extractor_error: RUNNER_FAILED,
  runner_error: RUNNER_FAILED,
  unknown: RUNNER_FAILED,
};

/** Codes only the Command Center writes (its sweeps). A runner cannot send these. */
export const SWEEP_ERROR_LINES: Readonly<Record<string, string>> = {
  runner_offline: "The computer that runs downloads was offline, so this didn't run.",
  attempts_exhausted: "The download stopped three times and was given up.",
};

/** Codes a tool that runs inside the request writes. */
export const WORKER_ERROR_LINES: Readonly<Record<string, string>> = {
  ai_account_missing: "Connect an AI account in Settings > AI brain to use this tool.",
  ai_account_unreadable: "Couldn't read the AI account. Try again.",
  ai_failed: "The AI account didn't answer. Try again.",
  // Tool-neutral (Codex review round 3, LOW): this line used to say "Try a
  // shorter post", which made no sense on Learn from a link (its input is a
  // link, not a post). ai_timeout fires once the AI account was actually
  // asked and did not answer in time; request_timeout (below) fires when
  // there was no time left to ask it at all - that one never blames the
  // account, because it was never contacted.
  ai_timeout: "The AI account took too long to answer; nothing was saved. Try again.",
  request_timeout: "This took too long and was stopped; nothing was saved. Try again.",
  // The provider's own refusal (lib/tools/worker/ai.ts toolCodeForStreamError).
  // A key or model problem is one only an owner or admin can fix: the line says
  // so and where, so nobody presses Try again on something that cannot work.
  ai_key_refused:
    "Your workspace's AI account refused the request. An owner or admin needs to check its key and billing in Settings > AI brain.",
  ai_model_not_found:
    "The AI model chosen in Settings > AI brain isn't available to this AI account. An owner or admin needs to pick another model there.",
  ai_rate_limited:
    "Your workspace's AI account is rate-limited or out of quota. Try again in a minute, or an owner or admin can check its billing in Settings > AI brain.",
  ai_provider_down: "The AI provider didn't answer (it was busy or timed out); nothing was saved. Try again in a few minutes.",
  ai_blocked: "The AI provider's safety filter blocked this. Change the text and try again.",
  ai_unusable_answer: "The AI answered, but not in a form this tool can use; nothing was saved. Try again.",
  [AI_BUDGET_EXHAUSTED]: AI_BUDGET_SENTENCES[AI_BUDGET_EXHAUSTED],
  [AI_BUDGET_UNPRICED_MODEL]: AI_BUDGET_SENTENCES[AI_BUDGET_UNPRICED_MODEL],
  [AI_USAGE_UNAVAILABLE]: AI_USAGE_UNAVAILABLE_SENTENCE,
  fetch_failed: "Couldn't open that link.",
  page_unreadable: "That page had no readable text. It may need a sign-in.",
  video_link_not_supported: "Video links can't be read here.",
  already_being_read: "This link is already being read.",
  interrupted: "This run stopped before it finished. Run it again.",
  tool_error: "This run stopped before it finished. Run it again.",
};

const RUNNER_CODE_RE = /^[a-z0-9_]{1,40}$/;

/** True when `code` has the shape a runner may send (lowercase, digits, underscores). */
export function isRunnerCodeShape(code: unknown): code is string {
  return typeof code === "string" && RUNNER_CODE_RE.test(code);
}

/** The code a runner's report is stored as: a known runner code, else `unknown`. */
export function storedRunnerCode(code: string): string {
  return Object.prototype.hasOwnProperty.call(RUNNER_ERROR_LINES, code) ? code : "unknown";
}

/** The line for a stored code. Never empty: an unknown code gets its side's generic line. */
export function toolErrorLine(code: string | null | undefined, runsOn: "worker" | "runner"): string {
  const c = code || "";
  const own = runsOn === "runner" ? { ...RUNNER_ERROR_LINES, ...SWEEP_ERROR_LINES } : WORKER_ERROR_LINES;
  if (Object.prototype.hasOwnProperty.call(own, c)) return own[c];
  return runsOn === "runner" ? RUNNER_FAILED : WORKER_ERROR_LINES.tool_error;
}
