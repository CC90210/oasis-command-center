/**
 * components/tools/tool-grid-format.ts - every word and number the Tools
 * section shows about a run, as pure functions, so tests check them without a
 * browser (tests/tools-grid.test.ts).
 *
 * Times are formatted HERE, on the client, after mount: a time the server
 * rendered as text would disagree with the browser's clock and redraw the page
 * (React #418). The grid renders no time at all in its first render.
 *
 * THE CARD'S LIFECYCLE (2026-10-26) is decided here too, as pure functions over
 * the runs the server lists. The panel above the form is in one of three states:
 *
 *   idle      nothing to show: just the form, ready for the next link
 *   running   runs in flight: each with its stage, a progress strip, a Refresh
 *   review    the newest finished run: its result (Download, Open in Extracted
 *             videos) and a Done button, or the failure with Try again and Dismiss
 *
 * The form stays under the panel in every state: a run that stalls on the PC
 * (a lease is 15 minutes, three attempts) must never lock the card, and the
 * server takes five runs in flight, so a second link can be queued at once.
 *
 * Done puts the finished runs away: the card remembers, per tool in
 * localStorage, the newest run it put away (doneThroughKey), and liveRuns hides
 * every finished run from then or before. A run still in flight is never
 * hidden. CC, 2026-10-25: re-entering the Video extractor showed the previous
 * run for good, and the "Done" it showed was the run's status word, not a
 * button. The history drawer under the card keeps listing every run regardless.
 */
import { timeAgo } from "@/lib/devices/presence";
import type { ToolField } from "@/lib/tools/registry";
import type { JobView } from "@/lib/tools/types";

export const STATUS_WAITING = "Waiting";
export const STATUS_DOWNLOADING = "Downloading";
export const STATUS_UPLOADING = "Uploading";
export const STATUS_WORKING = "Working";
export const STATUS_DONE = "Done";
export const STATUS_FAILED = "Failed";

export const NOT_SET_UP = "Tools are not set up yet.";
export const CONNECT_AI = "Connect an AI account in Settings > AI brain to use this tool.";
export const AI_UNREADABLE = "Couldn't read the AI account. Try again.";
/** A runner tool whose computer has not checked in lately (CatalogToolState runner_offline). */
export const RUNNER_OFFLINE =
  "This tool runs on the OASIS PC, which is offline right now. Turn it on, give it a minute, then press Check connection. Past runs stay below.";
export const CHECK_CONNECTION = "Check connection";
export const CHECKING_CONNECTION = "Checking...";
export const SAVED_TO_TRAINING = "Saved to Training material.";
export const RUN_STOPPED = "This run stopped before it finished. Run it again.";
/** The run request got no answer: it may or may not have started. The card keeps the same idempotency key, so a second press is the same run. */
export const RUN_UNCONFIRMED =
  "Couldn't confirm whether this run started. Check the runs below, or press the button again with the same link: a retry never starts a second run.";
export const RUNS_UNREADABLE = "Couldn't read the recent runs.";

export const DONE_LABEL = "Done";
export const DISMISS_LABEL = "Dismiss";
export const TRY_AGAIN_LABEL = "Try again";
export const REFRESH_LABEL = "Refresh";
export const REFRESHING_LABEL = "Refreshing...";
export const STARTING_LABEL = "Starting...";
export const OPEN_EXTRACTED = "Open in Extracted videos";
export const ALL_EXTRACTED = "All extracted videos";

/** Poll a card's runs every 3 s while one is in flight, for at most 30 minutes. */
export const POLL_EVERY_MS = 3_000;
export const POLL_FOR_MS = 30 * 60_000;
/** How often an open card counts "seen n min ago" again. */
export const SEEN_REFRESH_MS = 30_000;
/** How many runs a card reads for its history drawer (GET /api/tools/jobs caps at 20). */
export const HISTORY_LIMIT = 10;
/** A read of the runs or a run request waits this long before the card gives up on it. */
export const READ_TIMEOUT_MS = 15_000;
export const RUN_TIMEOUT_MS = 45_000;
/**
 * Dispatched on window when a card's last in-flight run finishes. A page that lists
 * what runs write (Agent training's "What it has learned") listens and re-reads, so
 * a finished run shows up without a manual reload.
 */
export const TOOL_RUN_FINISHED_EVENT = "oasis:tool-run-finished";
/**
 * Dispatched on window when an offline card's Check connection is pressed. The
 * page's RefreshOnToolRun re-reads the server data (the catalog decides online
 * or offline there), so the card needs no router of its own.
 */
export const TOOL_RECHECK_EVENT = "oasis:tool-recheck";

export const VIDEO_TOOL_KEY = "video_download";

export function isInFlight(job: Pick<JobView, "status">): boolean {
  return job.status === "queued" || job.status === "claimed" || job.status === "running";
}

/**
 * When a card reads its runs again: POLL_EVERY_MS from now while one of them is
 * in flight, until POLL_FOR_MS after the polling started; null = no read.
 */
export function nextPollIn(jobs: ReadonlyArray<Pick<JobView, "status">> | null, pollStartedAt: number | null, nowMs: number): number | null {
  if (!(jobs ?? []).some(isInFlight)) return null;
  if (pollStartedAt !== null && nowMs - pollStartedAt > POLL_FOR_MS) return null;
  return POLL_EVERY_MS;
}

/** A card's runs after the run route answered one: that run first, never twice, HISTORY_LIMIT at most. */
export function withRun(jobs: readonly JobView[] | null, job: JobView): JobView[] {
  return [job, ...(jobs ?? []).filter((j) => j.id !== job.id)].slice(0, HISTORY_LIMIT);
}

/** The localStorage key under which a card remembers the newest run Done put away (its created_at). */
export function doneThroughKey(toolKey: string): string {
  return `oasis:tools:${toolKey}:done-through`;
}

/**
 * True when `job` was created at or before `through` (the created_at of the newest
 * run Done put away). Both are the server's ISO times. A value that does not
 * parse (a hand-edited or corrupt stored one) puts nothing away: showing a run
 * twice is cheap, hiding one is not.
 */
export function isPutAway(job: Pick<JobView, "created_at">, through: string | null): boolean {
  if (through === null) return false;
  const a = Date.parse(job.created_at);
  const b = Date.parse(through);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a <= b;
}

/** The runs a card still shows above its form: every run in flight, and every finished run Done has not put away. Newest first, as read. */
export function liveRuns(jobs: ReadonlyArray<JobView> | null, through: string | null): JobView[] {
  return (jobs ?? []).filter((j) => isInFlight(j) || !isPutAway(j, through));
}

export type CardPhase = "idle" | "running" | "review";

/** The panel's state from the live runs: any in flight = running; else a finished one = review; else idle. */
export function cardPhase(live: ReadonlyArray<Pick<JobView, "status">>): CardPhase {
  if (live.some(isInFlight)) return "running";
  return live.length > 0 ? "review" : "idle";
}

/** The headline over a finished run. */
export function reviewHeadline(job: Pick<JobView, "status">, toolKey: string): string {
  if (job.status === "failed") return "Didn't finish";
  return toolKey === VIDEO_TOOL_KEY ? "Video extracted" : "Finished";
}

/** The title a finished run reported (the video's own title), or null. */
export function resultTitle(job: Pick<JobView, "result">): string | null {
  const r = job.result;
  if (!r || typeof r !== "object") return null;
  const title = (r as { title?: unknown }).title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

/** What the history drawer is called: the Video extractor's is its Extracted videos. */
export function historyLabel(toolKey: string): string {
  return toolKey === VIDEO_TOOL_KEY ? "Extracted videos" : "Recent runs";
}

/** The line under Done / Dismiss: what pressing it does, and that nothing is lost. */
export function doneHint(toolKey: string, failed: boolean): string {
  if (failed) return "Dismiss clears this card for the next run. The failed run stays listed below.";
  return toolKey === VIDEO_TOOL_KEY
    ? "Done clears this card for the next link. The video stays in Extracted videos."
    : "Done clears this card for the next run. The result stays listed below.";
}

/**
 * What a card sends to run its tool: each field's value, except a select the
 * person never changed. The tool decides then: Learn gives a new note the
 * default label, and a link already learned keeps the label it has.
 */
export function runInput(
  fields: ReadonlyArray<Pick<ToolField, "name" | "kind" | "alwaysSend">>,
  values: Readonly<Record<string, string>>,
  chosen: ReadonlySet<string>,
): Record<string, string> {
  const input: Record<string, string> = {};
  for (const f of fields) {
    if (f.kind === "select" && !chosen.has(f.name) && !f.alwaysSend) continue;
    input[f.name] = values[f.name] ?? "";
  }
  return input;
}

/** The one-word state of a run. A claimed download is already in the runner's hands. */
export function statusLabel(job: Pick<JobView, "status" | "stage">, runsOn: "worker" | "runner"): string {
  switch (job.status) {
    case "queued":
      return STATUS_WAITING;
    case "claimed":
      return runsOn === "runner" ? STATUS_DOWNLOADING : STATUS_WORKING;
    case "running":
      if (runsOn === "worker") return STATUS_WORKING;
      return job.stage === "uploading" ? STATUS_UPLOADING : STATUS_DOWNLOADING;
    case "done":
      return STATUS_DONE;
    case "failed":
      return STATUS_FAILED;
    default:
      return STATUS_WAITING;
  }
}

/** A run's time of day in the viewer's own clock. Client-side only. */
export function runTime(iso: string, locale?: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Newer ICU puts a narrow no-break space before AM/PM: one plain space reads the same.
  return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).replace(/\s+/g, " ");
}

export const runsOnText = (label: string) => `Runs on ${label}`;

/** "seen 3 min ago" for a runner last seen at `lastSeenAt` (ISO), in the one time-ago vocabulary on the viewer's clock; null when the time does not parse. */
export function seenLine(lastSeenAt: string, nowMs: number): string | null {
  return Number.isFinite(Date.parse(lastSeenAt)) ? `seen ${timeAgo(lastSeenAt, { now: nowMs })}` : null;
}
export const charsText = (n: number, max: number) => `${n} of ${max} characters`;
export const OVER_LIMIT = "Over the limit";

/** The line for a URL field the validator refused, by tool, or null for no line. */
export function urlFieldLine(toolKey: string, code: string): string | null {
  if (code === "required") return null;
  if (toolKey === VIDEO_TOOL_KEY) return "That link can't be downloaded. Paste the post's own link.";
  if (code === "video_link_not_supported") return "Video links can't be read here.";
  return "Couldn't open that link.";
}

/**
 * The line for a run the server refused before it started (no run exists):
 * its own message when it sent one (runner offline, five in flight, not set
 * up), else the generic line.
 */
export function refusalLine(status: number, body: unknown): string {
  const b = body && typeof body === "object" ? (body as { error?: unknown; message?: unknown }) : {};
  if (typeof b.message === "string" && b.message && status !== 500) return b.message;
  if (b.error === "not_set_up") return NOT_SET_UP;
  return RUN_STOPPED;
}

/** Copy text for the result, as the card shows it. */
export function variantLines(v: { chars: number; max_chars: number; over_limit: boolean }): string[] {
  return v.over_limit ? [charsText(v.chars, v.max_chars), OVER_LIMIT] : [charsText(v.chars, v.max_chars)];
}
