/**
 * lib/site-scan/view.ts — the public shape of a scan, and the stage ticks the page draws.
 *
 * The page polls GET /api/scan/:id every two seconds while anything is running. A stage is
 * "done" when its data exists, "running" when it is the next one and the scan is still being
 * worked on, "skipped" when the scan finished without it, and "pending" otherwise.
 */
import { ENRICH_WAIT_MINUTES, SCAN_STAGES, STAGE_TITLES, type ScanRow, type ScanStage, type ScanView } from "@/lib/site-scan/types";

type StageState = ScanView["stages"][number]["state"];

export function enrichOverdue(row: ScanRow, now: Date): boolean {
  if (row.status !== "enriching") return false;
  return now.getTime() - new Date(row.updatedAt).getTime() > ENRICH_WAIT_MINUTES * 60_000;
}

export function readOverdue(row: ScanRow, now: Date): boolean {
  if (row.status !== "reading" && row.status !== "queued") return false;
  return now.getTime() - new Date(row.updatedAt).getTime() > 3 * 60_000;
}

function has(row: ScanRow, stage: ScanStage): boolean {
  switch (stage) {
    case "read":
      return !!row.facts;
    case "health":
      return !!row.facts && (row.facts.checks.length > 0 || !!row.facts.pagespeed);
    case "profile":
      return !!row.enrich?.category || (!!row.narrative && row.narrative.source !== "template") || (!!row.enrich && row.enrich.keywords.length > 0);
    case "segments":
      return !!row.enrich && row.enrich.segments.length > 0;
    case "prospects":
      return !!row.enrich && row.enrich.prospects.length > 0;
    case "email":
      return !!row.narrative?.email;
    case "score":
      return !!row.score;
    case "done":
      return row.status === "done";
  }
}

export function stageStates(row: ScanRow, now: Date): ScanView["stages"] {
  const finished = row.status === "done" || row.status === "failed" || enrichOverdue(row, now);
  const working = row.status === "reading" || row.status === "queued" || (row.status === "enriching" && !finished);
  let runningAssigned = false;
  return SCAN_STAGES.map((key) => {
    let state: StageState;
    if (key === "done") state = row.status === "done" ? "done" : finished ? (row.status === "failed" ? "skipped" : "done") : "pending";
    else if (has(row, key)) state = "done";
    else if (finished) state = "skipped";
    else if (working && !runningAssigned) {
      state = "running";
      runningAssigned = true;
    } else state = "pending";
    return { key, title: STAGE_TITLES[key], state };
  });
}

const ERROR_WORDS: Record<string, string> = {
  not_a_website: "That address is not a public website.",
  read_failed: "The site could not be read from here. Check the address and try again.",
  read_timeout: "Reading the site took too long. Try again in a minute.",
};

export function toView(row: ScanRow, now: Date): ScanView {
  const facts = row.facts
    ? { ...row.facts, signals: row.facts.signals ? { ...row.facts.signals, text_excerpt: "" } : null }
    : null;
  return {
    id: row.id,
    domain: row.domain,
    url: row.url,
    status: enrichOverdue(row, now) ? "done" : row.status,
    stages: stageStates(row, now),
    facts,
    score: row.score,
    enrich: row.enrich,
    narrative: row.narrative,
    claimed: row.outcome !== "none",
    error: row.status === "failed" ? (ERROR_WORDS[row.errorCode ?? ""] ?? "The scan could not finish.") : null,
    created_at: row.createdAt,
  };
}
