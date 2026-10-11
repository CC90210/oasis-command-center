"use client";

/**
 * components/tools/ToolGrid.tsx - the Tools section: one card per tool the
 * workspace can use (lib/tools/catalog.ts decides which), each with its fields,
 * a Run button, the result of its last run and its recent runs.
 *
 * Every card works end to end or is not drawn: a tool that needs an AI account
 * shows the connect line and a link instead of fields; the video downloader is
 * in the catalog only while its runner is live. No founders imports here, so a
 * per-workspace Toolkit page can mount the same grid later.
 *
 * The first render shows no time and no run (runs load after mount), so the
 * server's markup and the browser's first paint are the same (React #418).
 * While one of a card's runs is in flight the card polls every 3 s, for at
 * most 30 minutes; it also refreshes when the window regains focus.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { CORPUS_LABEL_COPY, type CorpusLabel } from "@/lib/founders/ingest-core";
import { inputRefusalLine, toolByKey } from "@/lib/tools/registry";
import { setupHref } from "@/lib/setup-links";
import type { CatalogTool, JobView, ToolCatalog } from "@/lib/tools/types";
import {
  AI_UNREADABLE,
  CONNECT_AI,
  NOT_SET_UP,
  RUN_STOPPED,
  SAVED_TO_TRAINING,
  SEEN_REFRESH_MS,
  isInFlight,
  nextPollIn,
  refusalLine,
  runInput,
  runTime,
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
  /** A download opens in the Library at this prefix + its asset id. */
  assetHrefPrefix: string;
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

export function ToolGrid({
  catalog,
  runEndpoint = "/api/tools/run",
  jobsEndpoint = "/api/tools/jobs",
  assetHrefPrefix,
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

function ToolCard({ tool, runEndpoint, jobsEndpoint, assetHrefPrefix, settingsAiHref, showCodes }: CardProps) {
  const def = toolByKey(tool.key);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.fields.map((f) => [f.name, f.defaultValue ?? ""])),
  );
  /** The selects the person changed: an untouched one is not sent (runInput). */
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [mounted, setMounted] = useState(false);
  /** The viewer's clock for "seen n min ago", set after mount and every SEEN_REFRESH_MS. */
  const [clock, setClock] = useState<number | null>(null);
  /** Counts finished reads, so a failed read still schedules the next poll. */
  const [reads, setReads] = useState(0);
  const pollStart = useRef<number | null>(null);
  const ready = tool.state === "ready";
  const lastSeenAt = tool.runner?.lastSeenAt ?? null;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${jobsEndpoint}?tool=${encodeURIComponent(tool.key)}&limit=5`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; jobs?: JobView[] } | null;
      if (res.ok && body?.ok && Array.isArray(body.jobs)) setJobs(body.jobs);
      else console.warn("[tools.grid] could not read recent runs", { tool: tool.key, status: res.status });
    } catch (err) {
      // What is on screen stays; the next poll or focus reads again.
      console.warn("[tools.grid] could not read recent runs", { tool: tool.key, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setReads((n) => n + 1);
    }
  }, [jobsEndpoint, tool.key]);

  useEffect(() => {
    setMounted(true);
    if (!ready) return;
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready, load]);

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

  const validation = def ? def.validate(values) : null;
  const canRun = ready && !busy && validation?.ok === true;

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch(runEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A fresh key per press: a retried request is one run, a second press is another.
        body: JSON.stringify({ tool: tool.key, input: runInput(tool.fields, values, chosen), idempotency_key: crypto.randomUUID() }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; job?: JobView } | null;
      if (res.ok && body?.ok && body.job) {
        const job = body.job;
        pollStart.current = null;
        setJobs((prev) => withRun(prev, job));
        if (tool.runsOn === "runner") setValues((v) => ({ ...v, url: "" }));
      } else {
        setRefusal(refusalLine(res.status, body));
      }
    } catch {
      setRefusal(RUN_STOPPED);
    } finally {
      setBusy(false);
    }
  }

  const latest = jobs?.[0] ?? null;
  const seen = clock !== null && lastSeenAt ? seenLine(lastSeenAt, clock) : null;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-bg-border bg-bg-panel p-4" aria-labelledby={`tool-${tool.key}`}>
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

      {ready && (
        <form
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
            {tool.runLabel}
          </button>
          {refusal && (
            <p role="alert" className="text-xs text-status-hot">
              {refusal}
            </p>
          )}
        </form>
      )}

      {ready && latest && (
        <div aria-live="polite" className="space-y-2 border-t border-bg-border pt-3">
          <LatestRun job={latest} tool={tool} assetHrefPrefix={assetHrefPrefix} showCodes={showCodes} />
        </div>
      )}

      {ready && jobs && jobs.length > 0 && (
        <details className="group">
          <summary className={`flex cursor-pointer items-center text-xs font-medium text-fg-muted ${TAP}`}>Recent runs</summary>
          <ul className="mt-1 divide-y divide-bg-border">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-[11px] text-fg-dim">
                <span className="font-medium text-fg-muted">{statusLabel(j, tool.runsOn)}</span>
                {mounted && <span>{runTime(j.created_at)}</span>}
                <span className="min-w-0 max-w-full truncate">{j.input_summary}</span>
                {j.status === "done" && j.asset_id && (
                  <a className="text-accent hover:underline" href={`${assetHrefPrefix}${j.asset_id}`}>
                    Open in Library
                  </a>
                )}
                {j.status === "failed" && j.error_message && <span className="w-full">{j.error_message}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

/** The last run of a card, as the card shows it. Exported so tests render every result with real payloads. */
export function LatestRun({ job, tool, assetHrefPrefix, showCodes }: { job: JobView; tool: Pick<CatalogTool, "key" | "runsOn">; assetHrefPrefix: string; showCodes: boolean }) {
  if (isInFlight(job)) return <p className="text-xs font-medium text-fg-muted">{statusLabel(job, tool.runsOn)}</p>;
  if (job.status === "failed") {
    return (
      <p className="text-xs text-status-hot">
        {job.error_message}
        {showCodes && job.error_code ? <span className="ml-2 font-mono text-[10px] text-fg-dim">{job.error_code}</span> : null}
      </p>
    );
  }
  const r = job.result as Record<string, unknown> | null;
  if (!r) return <p className="text-xs font-medium text-fg-muted">{statusLabel(job, tool.runsOn)}</p>;
  switch (tool.key) {
    case "repurpose_post":
      return <RepurposeResult r={r} />;
    case "learn_from_link":
      return <LearnResult r={r} />;
    case "video_download":
      return (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-fg-muted">{statusLabel(job, tool.runsOn)}</span>
          {job.asset_id && (
            <a href={`${assetHrefPrefix}${job.asset_id}`} className={`btn-secondary inline-flex items-center ${TAP}`}>
              Open in Library
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
