/**
 * components/tools/tool-grid-format.ts - every word and number the Tools
 * section shows about a run, as pure functions, so tests check them without a
 * browser (tests/tools-grid.test.ts).
 *
 * Times are formatted HERE, on the client, after mount: a time the server
 * rendered as text would disagree with the browser's clock and redraw the page
 * (React #418). The grid renders no time at all in its first render.
 */
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
export const SAVED_TO_TRAINING = "Saved to Training material.";
export const RUN_STOPPED = "This run stopped before it finished. Run it again.";

/** Poll a card's runs every 3 s while one is in flight, for at most 30 minutes. */
export const POLL_EVERY_MS = 3_000;
export const POLL_FOR_MS = 30 * 60_000;

export function isInFlight(job: Pick<JobView, "status">): boolean {
  return job.status === "queued" || job.status === "claimed" || job.status === "running";
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
export const seenText = (minutes: number) => `seen ${Math.max(0, Math.floor(minutes))} min ago`;
export const scoreText = (pct: number) => `Score ${pct}%`;
export const charsText = (n: number, max: number) => `${n} of ${max} characters`;
export const OVER_LIMIT = "Over the limit";

/** The scorer's hard-fail codes in words. */
export function hardFailLine(code: string): string {
  if (code === "preamble") return "Opens with a greeting or preamble.";
  if (code === "hashtags") return "More than 5 hashtags.";
  return code;
}

/** The line for a URL field the validator refused, by tool, or null for no line. */
export function urlFieldLine(toolKey: string, code: string): string | null {
  if (code === "required") return null;
  if (toolKey === "video_download") return "That link can't be downloaded. Paste the post's own link.";
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
