"use client";

/**
 * components/tools/ToolGrid.tsx - the Tools section: one card per tool the
 * workspace can use (lib/tools/catalog.ts decides which), each with its fields,
 * a Run button and its runs.
 *
 * THE LIFECYCLE (2026-10-26). Above the form, a card shows every run in flight
 * (each with its stage, a progress strip, a Refresh) and, under those, every
 * finished run not yet put away, newest first, each with its result (Download,
 * Open in Extracted videos) and its own Done, or its failure with Try again and
 * Dismiss. Done puts away exactly the run it sits on and puts the cursor in the
 * field; the card remembers the put-away ids per workspace and tool in
 * localStorage, so leaving the page and coming back never brings back a run
 * already dealt with. The form itself stays in every state: a run that stalls
 * on the PC must never lock the card, and a second link can be queued while
 * the first downloads (the server takes five). Which runs show is a pure
 * function of the runs the server lists (components/tools/tool-grid-format.ts
 * liveRuns / cardPhase), checked without a browser by tests/tools-grid.test.ts;
 * the states themselves are driven in a real browser by tests/tools-grid.browser.py.
 *
 * WHY. CC, 2026-10-25: re-entering the Video extractor showed the previous run
 * for good, and the "Done" it showed was the run's status word drawn where a
 * button belongs, so it read as a locked button. The form also sat above the
 * result, so on a phone Download was below the fold.
 *
 * Every card works end to end or is not drawn: a tool that needs an AI account
 * shows the connect line and a link instead of fields; a runner tool whose
 * computer is offline (runner_offline) says so, offers Check connection (the
 * page re-reads its server data: TOOL_RECHECK_EVENT, heard by
 * components/tools/RefreshOnToolRun.tsx) and keeps its past runs, with no Run
 * button. No founders imports here, so a per-workspace Toolkit page can mount
 * the same grid later; the download and Extracted videos URLs come in as props.
 *
 * The history drawer (Extracted videos on the Video extractor, Recent runs
 * elsewhere) lists the newest HISTORY_LIMIT runs whatever Done put away, each
 * with Download and Open, and leads to the whole Extracted videos list. That
 * list lost its tab in Content's bar the same day: the history belongs inside
 * the tool that makes it (CC, 2026-10-25).
 *
 * The first render shows no time and no run (runs load after mount), so the
 * server's markup and the browser's first paint are the same (React #418).
 * While one of a card's runs is in flight the card polls every 3 s, for at
 * most 30 minutes; it also refreshes when the window regains focus, which also
 * restarts that clock. A poll never touches the Refresh button; only a press
 * does. Each read carries a version and a stale one is dropped, so a read that
 * started before a run was accepted never replaces that run with an older
 * snapshot. A run request with no clear answer (no response, or a server error)
 * is not proof it was refused: the card says so, reads the runs at once, and
 * keeps the same idempotency key for an unchanged input, so pressing the button
 * again is the same run (POST /api/tools/run dedupes on the key). Deadlines are
 * an AbortController and a timer, as lib/meet/room-client.ts makes them:
 * AbortSignal.timeout is missing in Safari before 16.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { CORPUS_LABEL_COPY, type CorpusLabel } from "@/lib/founders/ingest-core";
import { inputRefusalLine, toolByKey } from "@/lib/tools/registry";
import { setupHref } from "@/lib/setup-links";
import type { CatalogTool, JobView, ToolCatalog } from "@/lib/tools/types";
import {
  AI_UNREADABLE,
  ALL_EXTRACTED,
  CHECK_CONNECTION,
  CHECKING_CONNECTION,
  CONNECT_AI,
  DISMISS_LABEL,
  DONE_LABEL,
  HISTORY_LIMIT,
  NOT_SET_UP,
  OPEN_EXTRACTED,
  READ_TIMEOUT_MS,
  REFRESH_LABEL,
  REFRESHING_LABEL,
  RELOAD_RUNS_LABEL,
  RUN_UNCONFIRMED,
  RUNNER_OFFLINE,
  RUNS_UNREADABLE,
  SAVED_TO_TRAINING,
  SEEN_REFRESH_MS,
  STARTING_LABEL,
  STILL_OFFLINE,
  TOOL_RECHECK_EVENT,
  TOOL_RUN_FINISHED_EVENT,
  TRY_AGAIN_LABEL,
  VIDEO_CARD_ID,
  VIDEO_TOOL_KEY,
  cardPhase,
  doneHint,
  doneIdsKey,
  historyLabel,
  isInFlight,
  liveRuns,
  nextPollIn,
  parseDoneIds,
  refusalLine,
  rememberDone,
  resultTitle,
  reviewHeadline,
  runInput,
  runTime,
  runTimeoutMs,
  runsOnText,
  seenLine,
  statusLabel,
  urlFieldLine,
  variantLines,
  withRun,
} from "@/components/tools/tool-grid-format";

export type ToolGridProps = {
  catalog: ToolCatalog;
  runEndpoint?: string;
  jobsEndpoint?: string;
  /** A finished extract opens at this prefix + its asset id (Extracted videos, that video first). */
  assetHrefPrefix: string;
  /** Download saves the file from this prefix + asset id + "/download"; empty = no Download button. */
  assetDownloadPrefix?: string;
  /** The whole Extracted videos list, linked from the Video extractor's history drawer; empty = no link. */
  extractedVideosHref?: string;
  /** What Done remembers is kept under this scope (the workspace's tenant id), so two workspaces on one browser never share it. */
  storageScope?: string;
  settingsAiHref?: string;
  /** Founders see a failure's code next to its line; a client workspace never does. */
  showCodes?: boolean;
  /** Spacing around the section, set by the page that places it. */
  className?: string;
  /** False when a caller already supplies the "Tools" heading (a disclosure it is nested in). */
  showHeading?: boolean;
};

const HEADING = "px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";
const TAP = "min-h-11 min-w-11";
/** How long Check connection reads "Checking..." before the card concludes the PC is still offline. */
const CHECKING_FOR_MS = 4_000;

/** A deadline of `ms`: `signal` aborts once it passes, `done` stops the timer when the call is over. */
function deadline(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => window.clearTimeout(timer) };
}

/** The put-away ids under `key`, or [] where storage is refused (private mode) or holds junk. */
function readDoneIds(key: string): string[] {
  try {
    return parseDoneIds(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

export function ToolGrid({
  catalog,
  runEndpoint = "/api/tools/run",
  jobsEndpoint = "/api/tools/jobs",
  assetHrefPrefix,
  assetDownloadPrefix = "",
  extractedVideosHref = "",
  storageScope = "",
  settingsAiHref = setupHref("ai_account"),
  showCodes = false,
  className = "",
  showHeading = true,
}: ToolGridProps) {
  return (
    <section aria-labelledby={showHeading ? "tools-heading" : undefined} aria-label={showHeading ? undefined : "Tools"} className={`space-y-3 ${className}`.trim()}>
      {showHeading && (
        <h2 id="tools-heading" className={HEADING}>
          Tools
        </h2>
      )}
      {!catalog.installed ? (
        <p className="px-1 text-sm text-fg-muted">{NOT_SET_UP}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {catalog.tools.map((tool) => (
            <ToolCard
              key={tool.key}
              tool={tool}
              runEndpoint={runEndpoint}
              jobsEndpoint={jobsEndpoint}
              assetHrefPrefix={assetHrefPrefix}
              assetDownloadPrefix={assetDownloadPrefix}
              extractedVideosHref={extractedVideosHref}
              storageScope={storageScope}
              settingsAiHref={settingsAiHref}
              showCodes={showCodes}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type CardProps = Required<Omit<ToolGridProps, "catalog" | "className" | "showHeading">> & { tool: CatalogTool };

function ToolCard({ tool, runEndpoint, jobsEndpoint, assetHrefPrefix, assetDownloadPrefix, extractedVideosHref, storageScope, settingsAiHref, showCodes }: CardProps) {
  const def = toolByKey(tool.key);
  const isVideo = tool.key === VIDEO_TOOL_KEY;
  const storageKey = doneIdsKey(tool.key, storageScope);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.fields.map((f) => [f.name, f.defaultValue ?? ""])),
  );
  /** The selects the person changed: an untouched one is not sent (runInput). */
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [readError, setReadError] = useState(false);
  /** A read the person asked for (Refresh, Reload runs) is under way. A poll never sets it, so nothing flickers every 3 s. */
  const [reading, setReading] = useState(false);
  /** The runs Done put away, read from localStorage after mount and again on focus. */
  const [doneIds, setDoneIds] = useState<readonly string[]>([]);
  const [mounted, setMounted] = useState(false);
  /** The viewer's clock for "seen n min ago", set after mount and every SEEN_REFRESH_MS. */
  const [clock, setClock] = useState<number | null>(null);
  /** Counts finished reads, so a failed read still schedules the next poll. */
  const [reads, setReads] = useState(0);
  /** Check connection was pressed and the page's refresh has not changed this card yet. */
  const [checking, setChecking] = useState(false);
  /** The refresh came back and the PC had still not checked in. */
  const [stillOffline, setStillOffline] = useState(false);
  const pollStart = useRef<number | null>(null);
  /** Bumped by every read and by an accepted run: a read that finishes under an older version is dropped. */
  const readVersion = useRef(0);
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  /** The run request's idempotency key, kept while its input is unchanged and no run was confirmed. */
  const attempt = useRef<{ input: string; key: string } | null>(null);
  const ready = tool.state === "ready";
  /** Offline runner: no form, but the past runs (and their downloads) still show. */
  const showsRuns = ready || tool.state === "runner_offline";
  const lastSeenAt = tool.runner?.lastSeenAt ?? null;

  const load = useCallback(
    async (manual = false) => {
      const version = ++readVersion.current;
      if (manual) setReading(true);
      const wait = deadline(READ_TIMEOUT_MS);
      try {
        const res = await fetch(`${jobsEndpoint}?tool=${encodeURIComponent(tool.key)}&limit=${HISTORY_LIMIT}`, { cache: "no-store", signal: wait.signal });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; jobs?: JobView[] } | null;
        if (version !== readVersion.current) return;
        if (res.ok && body?.ok && Array.isArray(body.jobs)) {
          setJobs(body.jobs);
          setReadError(false);
        } else {
          setReadError(true);
          console.warn("[tools.grid] could not read recent runs", { tool: tool.key, status: res.status });
        }
      } catch (err) {
        // What is on screen stays, and the card says the read failed; the next poll, a focus or Reload runs reads again.
        if (version === readVersion.current) setReadError(true);
        console.warn("[tools.grid] could not read recent runs", { tool: tool.key, error: err instanceof Error ? err.message : String(err) });
      } finally {
        wait.done();
        if (version === readVersion.current) {
          setReading(false);
          setReads((n) => n + 1);
        }
      }
    },
    [jobsEndpoint, tool.key],
  );

  useEffect(() => {
    setMounted(true);
    setDoneIds(readDoneIds(storageKey));
    if (!showsRuns) return;
    void load();
    const onFocus = () => {
      // Another tab may have pressed Done; and a run still in flight after the polling window deserves a fresh one.
      setDoneIds(readDoneIds(storageKey));
      pollStart.current = null;
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      readVersion.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [showsRuns, load, storageKey]);

  // /founders/marketing/extracted links back to /tools#video-extractor: once the
  // card is on the page (and its section open), land on it.
  useEffect(() => {
    if (!isVideo || window.location.hash !== `#${VIDEO_CARD_ID}`) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(VIDEO_CARD_ID)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [isVideo]);

  useEffect(() => {
    if (!lastSeenAt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), SEEN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [lastSeenAt]);

  const inFlight = (jobs ?? []).some(isInFlight);
  useEffect(() => {
    if (!inFlight) {
      pollStart.current = null;
      return;
    }
    if (pollStart.current === null) pollStart.current = Date.now();
    const wait = nextPollIn(jobs, pollStart.current, Date.now());
    if (wait === null) return;
    const timer = window.setTimeout(() => void load(), wait);
    return () => window.clearTimeout(timer);
  }, [inFlight, jobs, reads, load]);

  // The moment the last in-flight run settles, tell the page. A mount with no run in
  // flight never fires it.
  const wasInFlight = useRef(false);
  useEffect(() => {
    if (inFlight) {
      wasInFlight.current = true;
      return;
    }
    if (!wasInFlight.current) return;
    wasInFlight.current = false;
    window.dispatchEvent(new CustomEvent(TOOL_RUN_FINISHED_EVENT, { detail: { tool: tool.key } }));
  }, [inFlight, tool.key]);

  // Check connection: "Checking..." until the page's refresh hands this card new
  // server data (the state or the last check-in changes); if CHECKING_FOR_MS pass
  // without that, the PC is still offline, and the card says so.
  useEffect(() => {
    setChecking(false);
    setStillOffline(false);
  }, [tool.state, lastSeenAt]);
  useEffect(() => {
    if (!checking) return;
    const timer = window.setTimeout(() => {
      setChecking(false);
      setStillOffline(true);
    }, CHECKING_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [checking]);

  const live = liveRuns(jobs, doneIds);
  const phase = ready ? cardPhase(live) : "idle";
  /** The runs in flight, newest first. */
  const running = live.filter(isInFlight);
  /** The finished runs Done has not put away, newest first, each with its own Done. */
  const finished = live.filter((j) => !isInFlight(j));

  const validation = def ? def.validate(values) : null;
  const canRun = ready && !busy && validation?.ok === true;

  async function run() {
    if (!canRun || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setRefusal(null);
    const wait = deadline(runTimeoutMs(tool.runsOn));
    try {
      const input = runInput(tool.fields, values, chosen);
      const fingerprint = JSON.stringify(input);
      // Same input, same key: a request that got no clear answer is retried as the same run.
      if (attempt.current?.input !== fingerprint) attempt.current = { input: fingerprint, key: crypto.randomUUID() };
      const res = await fetch(runEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: tool.key, input, idempotency_key: attempt.current.key }),
        signal: wait.signal,
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; job?: JobView } | null;
      if (res.ok && body?.ok && body.job) {
        const job = body.job;
        // A read that started before this answer must not replace the run with an older list.
        readVersion.current += 1;
        setReading(false);
        setReadError(false);
        attempt.current = null;
        pollStart.current = null;
        setJobs((prev) => withRun(prev, job));
        if (tool.runsOn === "runner") setValues((v) => ({ ...v, url: "" }));
        // A worker tool runs inside the request and answers already finished, so
        // the in-flight watcher above never sees it start: tell the page here.
        if (!isInFlight(job)) window.dispatchEvent(new CustomEvent(TOOL_RUN_FINISHED_EVENT, { detail: { tool: tool.key } }));
      } else if (res.status >= 400 && res.status < 500) {
        // The server answered and refused: no run exists, so the next press is a new request.
        setRefusal(refusalLine(res.status, body));
        attempt.current = null;
      } else {
        // A server error or an unreadable answer: the run may exist. Say so, keep the key, and look.
        setRefusal(RUN_UNCONFIRMED);
        void load();
      }
    } catch (err) {
      console.warn("[tools.grid] the run request got no answer", { tool: tool.key, error: err instanceof Error ? err.message : String(err) });
      setRefusal(RUN_UNCONFIRMED);
      void load();
    } finally {
      wait.done();
      submitting.current = false;
      setBusy(false);
    }
  }

  /** Done / Dismiss / Try again on one run: put that run away; restore its link if asked, never touch what was typed since; cursor to the first field. */
  function putAway(job: JobView, restoreInput: boolean) {
    // Merge with what is stored: another tab may have put runs away since this one mounted.
    const next = rememberDone([...readDoneIds(storageKey), ...doneIds], job.id);
    setDoneIds(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage refused: the card forgets on the next visit, which only shows the run again.
    }
    setRefusal(null);
    if (restoreInput) {
      const urlField = tool.fields.find((f) => f.kind === "url");
      if (urlField) setValues((v) => ({ ...v, [urlField.name]: job.input_summary }));
    }
    formRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus();
  }

  function recheck() {
    setStillOffline(false);
    setChecking(true);
    window.dispatchEvent(new CustomEvent(TOOL_RECHECK_EVENT, { detail: { tool: tool.key } }));
  }

  const seen = clock !== null && lastSeenAt ? seenLine(lastSeenAt, clock) : null;
  // A link comes back whole from the run's summary; the first 80 characters of a long text do not.
  const canRetry = tool.fields.some((f) => f.kind === "url");
  const history = jobs ?? [];

  return (
    <article
      id={isVideo ? VIDEO_CARD_ID : undefined}
      className="flex min-w-0 scroll-mt-24 flex-col gap-3 rounded-xl border border-bg-border bg-bg-panel p-4"
      aria-labelledby={`tool-${tool.key}`}
      data-phase={ready ? phase : tool.state}
    >
      <header className="space-y-1">
        <h3 id={`tool-${tool.key}`} className="text-sm font-semibold text-fg">
          {tool.title}
        </h3>
        <p className="text-xs leading-5 text-fg-muted">{tool.description}</p>
        {tool.runner && (
          <p className="text-[11px] text-fg-dim">
            {runsOnText(tool.runner.label)}
            {seen ? `, ${seen}` : null}
          </p>
        )}
      </header>

      {tool.state === "needs_ai_account" && (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">{CONNECT_AI}</p>
          <a href={settingsAiHref} className={`btn-secondary inline-flex items-center ${TAP}`}>
            Open Settings
          </a>
        </div>
      )}
      {tool.state === "ai_account_unreadable" && <p className="text-xs text-fg-muted">{AI_UNREADABLE}</p>}
      {tool.state === "runner_offline" && (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-fg-muted" data-testid={`tool-${tool.key}-offline`}>
            {RUNNER_OFFLINE}
          </p>
          <button type="button" className={`btn-secondary ${TAP}`} disabled={checking} onClick={recheck}>
            {checking ? CHECKING_CONNECTION : CHECK_CONNECTION}
          </button>
          {stillOffline && (
            <p className="text-[11px] text-fg-dim" role="status">
              {STILL_OFFLINE}
            </p>
          )}
        </div>
      )}

      {/* One live region, always in the tree, so what lands in it is announced; empty, it takes no room. */}
      {ready && (
        <div role="status" aria-live="polite" className="space-y-3 empty:hidden" data-testid={`tool-${tool.key}-panel`}>
          {running.length > 0 && <RunningList runs={running} tool={tool} />}
          {finished.map((job) => (
            <ReviewBlock
              key={job.id}
              job={job}
              tool={tool}
              assetHrefPrefix={assetHrefPrefix}
              assetDownloadPrefix={assetDownloadPrefix}
              showCodes={showCodes}
              onDone={() => putAway(job, false)}
              onRetry={canRetry ? () => putAway(job, true) : undefined}
            />
          ))}
        </div>
      )}
      {ready && running.length > 0 && (
        <div>
          <button
            type="button"
            className={`btn-secondary ${TAP}`}
            disabled={reading}
            onClick={() => {
              pollStart.current = null;
              void load(true);
            }}
          >
            {reading ? REFRESHING_LABEL : REFRESH_LABEL}
          </button>
        </div>
      )}

      {ready && (
        <form
          ref={formRef}
          className="space-y-3"
          // The tool's own validator decides (a link without https:// is fine);
          // the browser's built-in URL check would block it with its own bubble.
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {tool.fields.map((f) => {
            const id = `tool-${tool.key}-${f.name}`;
            const value = values[f.name] ?? "";
            const set = (next: string) => setValues((v) => ({ ...v, [f.name]: next }));
            const refused = value.trim() && validation && !validation.ok && validation.field === f.name ? validation.code : null;
            // A URL field says why a link was refused; any field whose refusal
            // has its own line says it (a post that is only a link).
            const line = refused === null ? null : f.kind === "url" ? urlFieldLine(tool.key, refused) : inputRefusalLine(refused);
            const lineId = `${id}-line`;
            return (
              <div key={f.name} className="space-y-1">
                <label htmlFor={id} className="block text-xs font-medium text-fg-muted">
                  {f.label}
                </label>
                {f.kind === "textarea" ? (
                  <textarea
                    id={id}
                    className={`textarea ${TAP}`}
                    rows={3}
                    value={value}
                    maxLength={f.maxLength}
                    disabled={busy}
                    aria-describedby={line ? lineId : undefined}
                    onChange={(e) => set(e.target.value)}
                  />
                ) : f.kind === "select" ? (
                  <select
                    id={id}
                    className={`select ${TAP}`}
                    value={value}
                    disabled={busy}
                    onChange={(e) => {
                      set(e.target.value);
                      setChosen((prev) => new Set(prev).add(f.name));
                    }}
                  >
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={id}
                    className={`input ${TAP}`}
                    type={f.kind === "url" ? "url" : "text"}
                    inputMode={f.kind === "url" ? "url" : undefined}
                    autoComplete="off"
                    value={value}
                    maxLength={f.maxLength}
                    disabled={busy}
                    aria-describedby={line ? lineId : undefined}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
                {line && (
                  <p id={lineId} className="text-[11px] text-fg-dim">
                    {line}
                  </p>
                )}
              </div>
            );
          })}
          <button type="submit" className={`btn-primary disabled:cursor-not-allowed disabled:opacity-40 ${TAP}`} disabled={!canRun}>
            {busy ? STARTING_LABEL : tool.runLabel}
          </button>
          {/* A dimmed button with no word on why reads as broken. While the one
              thing it needs is still empty, say which thing. */}
          {!busy && validation && !validation.ok && !(values[validation.field] ?? "").trim() && (
            <p className="text-[11px] text-fg-dim" data-testid={`tool-${tool.key}-needs-input`}>
              {`Add the ${(tool.fields.find((f) => f.name === validation.field)?.label ?? "details").toLowerCase()} above to turn ${tool.runLabel} on.`}
            </p>
          )}
          {refusal && (
            <p role="alert" className="text-xs text-status-hot">
              {refusal}
            </p>
          )}
        </form>
      )}

      {showsRuns && readError && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-status-hot">
          <span>{RUNS_UNREADABLE}</span>
          <button type="button" className={`btn-secondary ${TAP}`} disabled={reading} onClick={() => void load(true)}>
            {reading ? REFRESHING_LABEL : RELOAD_RUNS_LABEL}
          </button>
        </p>
      )}

      {showsRuns && history.length > 0 && (
        <RunHistory jobs={history} tool={tool} assetHrefPrefix={assetHrefPrefix} assetDownloadPrefix={assetDownloadPrefix} extractedVideosHref={extractedVideosHref} showTimes={mounted} />
      )}
    </article>
  );
}

/** The runs in flight, each at its stage, over a progress strip. Exported so a test can render it with real runs. */
export function RunningList({ runs, tool }: { runs: readonly JobView[]; tool: Pick<CatalogTool, "key" | "runsOn"> }) {
  return (
    <div className="space-y-2" data-testid={`tool-${tool.key}-running`}>
      <ul className="space-y-1">
        {runs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-medium text-fg-muted">{statusLabel(j, tool.runsOn)}</span>
            <span className="min-w-0 max-w-full truncate text-fg-dim">{j.input_summary}</span>
          </li>
        ))}
      </ul>
      <div className="h-1 w-full overflow-hidden rounded-full bg-bg-border" aria-hidden>
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
    </div>
  );
}

/** One finished run waiting for Done: its headline, its result or failure, and its buttons. Exported so a test can render every result with real payloads. */
export function ReviewBlock({
  job,
  tool,
  assetHrefPrefix,
  assetDownloadPrefix = "",
  showCodes,
  onDone,
  onRetry,
}: {
  job: JobView;
  tool: Pick<CatalogTool, "key" | "runsOn">;
  assetHrefPrefix: string;
  assetDownloadPrefix?: string;
  showCodes: boolean;
  onDone: () => void;
  /** Absent when the input cannot be restored whole (a long text), so no Try again is offered. */
  onRetry?: () => void;
}) {
  const failed = job.status !== "done";
  return (
    <div className="space-y-3" data-testid={`tool-${tool.key}-review`} data-job={job.id}>
      <div className="space-y-1">
        <p className={`text-sm font-semibold ${failed ? "text-status-hot" : "text-fg"}`}>{reviewHeadline(job, tool.key)}</p>
        <p className="break-all text-xs text-fg-muted">{resultTitle(job) ?? job.input_summary}</p>
      </div>
      {failed ? (
        <p className="text-xs text-status-hot">
          {job.error_message}
          {showCodes && job.error_code ? <span className="ml-2 font-mono text-[10px] text-fg-dim">{job.error_code}</span> : null}
        </p>
      ) : (
        <RunResult job={job} tool={tool} assetHrefPrefix={assetHrefPrefix} assetDownloadPrefix={assetDownloadPrefix} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {failed && onRetry && (
          <button type="button" className={`btn-primary ${TAP}`} onClick={onRetry}>
            {TRY_AGAIN_LABEL}
          </button>
        )}
        <button type="button" className={`btn-secondary ${TAP}`} data-testid={`tool-${tool.key}-done`} onClick={onDone}>
          {failed ? DISMISS_LABEL : DONE_LABEL}
        </button>
      </div>
      <p className="text-[11px] text-fg-dim">{doneHint(tool.key, failed)}</p>
    </div>
  );
}

/** The history drawer: the newest runs whatever Done put away, each with its links. Exported so a test can render it with real runs. */
export function RunHistory({
  jobs,
  tool,
  assetHrefPrefix,
  assetDownloadPrefix = "",
  extractedVideosHref = "",
  showTimes,
}: {
  jobs: readonly JobView[];
  tool: Pick<CatalogTool, "key" | "runsOn">;
  assetHrefPrefix: string;
  assetDownloadPrefix?: string;
  extractedVideosHref?: string;
  /** False in the first render: a time is the viewer's clock, drawn after mount. */
  showTimes: boolean;
}) {
  const isVideo = tool.key === VIDEO_TOOL_KEY;
  return (
    <details className="group border-t border-bg-border pt-3" data-testid={`tool-${tool.key}-history`}>
      <summary className={`flex cursor-pointer items-center text-xs font-medium text-fg-muted ${TAP}`}>{historyLabel(tool.key)}</summary>
      <ul className="mt-1 divide-y divide-bg-border">
        {jobs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1 text-[11px] text-fg-dim">
            {/* A finished row needs no status word: "Done" in a list is the word CC read as a
                locked button. Failed and in-flight rows still say what they are. */}
            {j.status !== "done" && <span className="font-medium text-fg-muted">{statusLabel(j, tool.runsOn)}</span>}
            {showTimes && <span>{runTime(j.created_at)}</span>}
            <span className="min-w-0 max-w-full truncate">{resultTitle(j) ?? j.input_summary}</span>
            {j.status === "done" && j.asset_id && assetDownloadPrefix && (
              <a className={`inline-flex items-center text-accent hover:underline ${TAP}`} href={`${assetDownloadPrefix}${j.asset_id}/download`}>
                Download
              </a>
            )}
            {j.status === "done" && j.asset_id && (
              <a className={`inline-flex items-center text-accent hover:underline ${TAP}`} href={`${assetHrefPrefix}${j.asset_id}`}>
                {OPEN_EXTRACTED}
              </a>
            )}
            {j.status === "failed" && j.error_message && <span className="w-full">{j.error_message}</span>}
          </li>
        ))}
      </ul>
      {isVideo && extractedVideosHref && (
        <a href={extractedVideosHref} className={`mt-1 inline-flex items-center text-xs font-medium text-accent hover:underline ${TAP}`}>
          {ALL_EXTRACTED}
        </a>
      )}
    </details>
  );
}

/** A finished run's result, as its review block shows it. */
export function RunResult({ job, tool, assetHrefPrefix, assetDownloadPrefix = "" }: { job: JobView; tool: Pick<CatalogTool, "key" | "runsOn">; assetHrefPrefix: string; assetDownloadPrefix?: string }) {
  const r = job.result as Record<string, unknown> | null;
  switch (tool.key) {
    case "repurpose_post":
      return r ? <RepurposeResult r={r} /> : null;
    case "learn_from_link":
      return r ? <LearnResult r={r} /> : null;
    case VIDEO_TOOL_KEY:
      return (
        <div className="flex flex-wrap items-center gap-2">
          {job.asset_id && assetDownloadPrefix && (
            <a href={`${assetDownloadPrefix}${job.asset_id}/download`} className={`btn-primary inline-flex items-center ${TAP}`}>
              Download
            </a>
          )}
          {job.asset_id && (
            <a href={`${assetHrefPrefix}${job.asset_id}`} className={`btn-secondary inline-flex items-center ${TAP}`}>
              {OPEN_EXTRACTED}
            </a>
          )}
        </div>
      );
    default:
      return null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const PLATFORM_NAMES: Array<[string, string]> = [
  ["linkedin", "LinkedIn"],
  ["instagram", "Instagram"],
  ["threads", "Threads"],
];

function RepurposeResult({ r }: { r: Record<string, unknown> }) {
  const variants = (r.variants ?? {}) as Record<string, { text?: unknown; chars?: unknown; max_chars?: unknown; over_limit?: unknown }>;
  return (
    <div className="space-y-2">
      {PLATFORM_NAMES.map(([key, name]) => {
        const v = variants[key];
        if (!v || typeof v.text !== "string") return null;
        const text = v.text;
        const lines = variantLines({ chars: Number(v.chars) || 0, max_chars: Number(v.max_chars) || 0, over_limit: v.over_limit === true });
        return (
          <div key={key} className="space-y-1.5 rounded-lg border border-bg-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-fg">{name}</span>
              <CopyTextButton text={text} />
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-fg">{text}</p>
            <p className={`text-[11px] ${v.over_limit === true ? "text-status-hot" : "text-fg-dim"}`}>{lines.join(". ")}</p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Copy, then "Copied" for a moment. lib/clipboard's copyText never throws: where
 * the browser refuses the clipboard it opens a prompt holding the text to copy
 * by hand, and the button does not claim it copied.
 */
function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`btn-secondary inline-flex items-center justify-center ${TAP}`}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

const ANALYSIS_LABELS: Array<[string, string]> = [
  ["hook", "Hook"],
  ["pacing", "Pacing"],
  ["tone", "Tone"],
  ["structure", "Structure"],
  ["steal", "Steal"],
  ["avoid", "Avoid"],
];

function LearnResult({ r }: { r: Record<string, unknown> }) {
  const a = (r.analysis ?? {}) as Record<string, unknown>;
  // The note's label as saved: a link learned before keeps the label it had, so
  // the card shows which one it is rather than the select's default.
  const labelTitle = typeof r.label === "string" ? CORPUS_LABEL_COPY[r.label as CorpusLabel]?.title : undefined;
  return (
    <div className="space-y-2">
      <dl className="space-y-1.5">
        {ANALYSIS_LABELS.map(([key, label]) => {
          const v = a[key];
          const shown = Array.isArray(v) ? strings(v).join(" / ") : typeof v === "string" ? v : "";
          if (!shown) return null;
          return (
            <div key={key}>
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-dim">{label}</dt>
              <dd className="text-xs leading-5 text-fg">{shown}</dd>
            </div>
          );
        })}
        {labelTitle && (
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-dim">This is</dt>
            <dd className="text-xs leading-5 text-fg">{labelTitle}</dd>
          </div>
        )}
      </dl>
      <p className="text-xs text-fg-muted">{SAVED_TO_TRAINING}</p>
    </div>
  );
}
