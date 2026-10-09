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
import { toolByKey } from "@/lib/tools/registry";
import type { CatalogTool, JobView, ToolCatalog } from "@/lib/tools/types";
import {
  AI_UNREADABLE,
  CONNECT_AI,
  NOT_SET_UP,
  POLL_EVERY_MS,
  POLL_FOR_MS,
  RUN_STOPPED,
  SAVED_TO_TRAINING,
  hardFailLine,
  isInFlight,
  refusalLine,
  runTime,
  runsOnText,
  scoreText,
  seenText,
  statusLabel,
  urlFieldLine,
  variantLines,
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
};

const HEADING = "px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";
const TAP = "min-h-11 min-w-11";

export function ToolGrid({
  catalog,
  runEndpoint = "/api/tools/run",
  jobsEndpoint = "/api/tools/jobs",
  assetHrefPrefix,
  settingsAiHref = "/settings/ai",
  showCodes = false,
  className = "",
}: ToolGridProps) {
  return (
    <section aria-labelledby="tools-heading" className={`space-y-3 ${className}`.trim()}>
      <h2 id="tools-heading" className={HEADING}>
        Tools
      </h2>
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

type CardProps = Required<Omit<ToolGridProps, "catalog" | "className">> & { tool: CatalogTool };

function ToolCard({ tool, runEndpoint, jobsEndpoint, assetHrefPrefix, settingsAiHref, showCodes }: CardProps) {
  const def = toolByKey(tool.key);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.fields.map((f) => [f.name, f.defaultValue ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [mounted, setMounted] = useState(false);
  /** Counts finished reads, so a failed read still schedules the next poll. */
  const [reads, setReads] = useState(0);
  const pollStart = useRef<number | null>(null);
  const ready = tool.state === "ready";

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

  const inFlight = (jobs ?? []).some(isInFlight);
  useEffect(() => {
    if (!inFlight) {
      pollStart.current = null;
      return;
    }
    if (pollStart.current === null) pollStart.current = Date.now();
    if (Date.now() - pollStart.current > POLL_FOR_MS) return;
    const timer = window.setTimeout(() => void load(), POLL_EVERY_MS);
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
        body: JSON.stringify({ tool: tool.key, input: values, idempotency_key: crypto.randomUUID() }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; job?: JobView } | null;
      if (res.ok && body?.ok && body.job) {
        const job = body.job;
        pollStart.current = null;
        setJobs((prev) => [job, ...(prev ?? []).filter((j) => j.id !== job.id)].slice(0, 5));
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
            {mounted ? `, ${seenText(tool.runner.lastSeenMinutes)}` : null}
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
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {tool.fields.map((f) => {
            const id = `tool-${tool.key}-${f.name}`;
            const value = values[f.name] ?? "";
            const set = (next: string) => setValues((v) => ({ ...v, [f.name]: next }));
            const line =
              f.kind === "url" && value.trim() && validation && !validation.ok && validation.field === f.name
                ? urlFieldLine(tool.key, validation.code)
                : null;
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
                    onChange={(e) => set(e.target.value)}
                  />
                ) : f.kind === "select" ? (
                  <select id={id} className={`select ${TAP}`} value={value} disabled={busy} onChange={(e) => set(e.target.value)}>
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
                    onChange={(e) => set(e.target.value)}
                  />
                )}
                {line && <p className="text-[11px] text-fg-dim">{line}</p>}
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

function LatestRun({ job, tool, assetHrefPrefix, showCodes }: { job: JobView; tool: CatalogTool; assetHrefPrefix: string; showCodes: boolean }) {
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
    case "score_hook":
      return <ScoreResult r={r} />;
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

function ScoreResult({ r }: { r: Record<string, unknown> }) {
  const pct = typeof r.score_pct === "number" ? r.score_pct : 0;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold text-fg">{scoreText(pct)}</p>
      {strings(r.hard_fails).map((c) => (
        <p key={c} className="text-xs text-status-hot">
          {hardFailLine(c)}
        </p>
      ))}
      {strings(r.suggestions).length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-fg-muted">
          {strings(r.suggestions).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
              <button
                type="button"
                className={`btn-secondary inline-flex items-center justify-center ${TAP}`}
                onClick={() => void navigator.clipboard?.writeText(text)}
              >
                Copy
              </button>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-fg">{text}</p>
            <p className={`text-[11px] ${v.over_limit === true ? "text-status-hot" : "text-fg-dim"}`}>{lines.join(". ")}</p>
          </div>
        );
      })}
    </div>
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
      </dl>
      <p className="text-xs text-fg-muted">{SAVED_TO_TRAINING}</p>
    </div>
  );
}
