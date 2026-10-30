"use client";

/**
 * The research behind the audit, on the engagement's "Research" tab (phase 3).
 *
 * After Gate 1 the Command Center reads the client's website again, runs
 * Google PageSpeed, has CC's Mac search the web with public facts only, and
 * reads each page the search found itself. The evidence rules then decide
 * every label (lib/ai-audit/evidence.ts) and the impact calculator gives
 * ranges (lib/ai-audit/impact.ts). This shows the stored run: what was
 * measured, what the client said, the likely problems to test, the estimates
 * with their assumptions (CC may change those), every gap and every source.
 * Internal only: nothing here reaches the client except through an audit CC
 * approves at Gate 2.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { EngagementView } from "@/lib/ai-audit/view";
import type { DocEstimate, DocFinding } from "@/lib/ai-audit/doc";
import { ASSUMPTION_KEYS, DEFAULT_ASSUMPTIONS, type AssumptionKey } from "@/lib/ai-audit/impact";
import { describeError, postAction } from "./api";

const IN_FLIGHT = ["queued", "running", "waiting_runner"];

const PHASE_WORDS: Readonly<Record<string, string>> = {
  site: "Reading the website",
  pagespeed: "Running Google PageSpeed",
  search: "Handing the web search to CC's Mac",
  waiting_search: "Waiting for the web search on CC's Mac",
  fetch: "Reading the pages the search found",
  assemble: "Checking the evidence and putting it together",
};

const STOP_WORDS: Readonly<Record<string, string>> = {
  stage_closed: "It stopped because the engagement left Research and writing.",
  research_failed: "A step failed three times, so it stopped. Press Research again to start a new run.",
  not_authorized: "It stopped because the authorization no longer holds. Authorize the profile again first.",
};

/** Why a writing pass over the opening changed nothing (lib/ai-audit/writing.ts step error codes). */
const WRITE_STOP_WORDS: Readonly<Record<string, string>> = {
  draft_changed: "the draft changed while it ran, so your version was kept",
  not_authorized: "the authorization no longer holds",
  write_failed: "the AI call failed three times",
  unreadable: "the AI's answer could not be read",
  nothing_kept: "no sentence it wrote passed the evidence check",
  rules_broken: "what it wrote broke an evidence rule, so it was held back",
  runner_offline: "the Mac was offline, so the pass was called off",
};

const LABEL_WORDS: Readonly<Record<DocFinding["label"], string>> = {
  verified: "Verified fact",
  client_reported: "Client-reported",
  estimate: "Reasonable estimate",
  hypothesis: "Hypothesis",
};

/** How far a page can be trusted, as the evidence rules weigh it: a benchmark needs high or medium. */
const RELIABILITY_WORDS: Readonly<Record<string, string>> = { high: "a public body", medium: "a named research firm", low: "not a reliable source for figures" };

const MODULE_WORDS: Readonly<Record<string, string>> = { profile: "Discovery profile", site: "Website", pagespeed: "Google PageSpeed", search: "Web search" };
const STATUS_WORDS: Readonly<Record<string, string>> = { done: "Done", partial: "Partly done", skipped: "Skipped", failed: "Failed" };

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function amount(n: number, unit: string): string {
  const v = Number.isInteger(n) ? n.toLocaleString("en-CA") : n.toLocaleString("en-CA", { maximumFractionDigits: 2 });
  if (unit === "$") return `$${v}`;
  if (unit === "%") return `${v}%`;
  if (unit === "share") return `${Math.round(n * 100)}%`;
  return unit ? `${v} ${unit}` : v;
}

function Label({ kind }: { kind: DocFinding["label"] }) {
  return <span className="shrink-0 rounded border border-hairline px-1.5 py-px text-[11px] text-fg-muted">{LABEL_WORDS[kind]}</span>;
}

/** Footnote numbers for a finding's sources, linked to the list at the end. */
function Cites({ ids, numbers }: { ids: readonly string[]; numbers: ReadonlyMap<string, number> }) {
  const known = ids.filter((id) => numbers.has(id));
  if (!known.length) return null;
  return (
    <span className="shrink-0 text-[11px] tabular-nums text-fg-dim">
      {known.map((id, i) => (
        <a key={id} href={`#research-source-${numbers.get(id)}`} className="hover:text-fg">
          {i ? " " : ""}[{numbers.get(id)}]
        </a>
      ))}
    </span>
  );
}

/** A page's claim shows the page it came from: a competitor's figures are never read as the client's (review of phase 3, F1). */
const fromAPage = (f: DocFinding) => f.id.startsWith("f-web-");

function FindingList({ title, items, numbers }: { title: string; items: readonly DocFinding[]; numbers: ReadonlyMap<string, number> }) {
  if (!items.length) return null;
  return (
    <div className="grid gap-1.5">
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      <ul className="grid gap-1.5">
        {items.map((f) => (
          <li key={f.id} className="grid min-w-0 gap-0.5">
            <div className="flex items-start gap-2">
              <Label kind={f.label} />
              <span className="min-w-0 break-words text-fg">
                {fromAPage(f) ? <span className="block text-[12px] text-fg-muted">{f.title}</span> : null}
                {f.statement}
              </span>
              <Cites ids={f.source_ids} numbers={numbers} />
            </div>
            {f.how_to_test ? <div className="pl-1 text-[12px] text-fg-muted">Test it: {f.how_to_test}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EstimateCard({ est, numbers }: { est: DocEstimate; numbers: ReadonlyMap<string, number> }) {
  return (
    <li className="grid gap-1 rounded-lg border border-hairline px-3 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Label kind="estimate" />
          <span className="font-medium text-fg">{est.title}</span>
        </div>
        <span className="tabular-nums text-fg">
          {amount(est.low, est.unit)} to {amount(est.high, est.unit)}
          {est.period ? ` ${est.period}` : ""}
        </span>
      </div>
      <div className="text-[12px] text-fg-muted">How: {est.formula}.</div>
      <ul className="grid gap-0.5 text-[12px] text-fg-muted">
        {est.inputs.map((x) => (
          <li key={x.name} className="flex flex-wrap items-baseline gap-x-2">
            <span>
              {x.name}: <span className="tabular-nums text-fg">{amount(x.value, x.unit ?? "")}</span>
            </span>
            <span className="text-fg-dim">{LABEL_WORDS[x.label]}</span>
            {x.basis && numbers.has(x.basis) ? <Cites ids={[x.basis]} numbers={numbers} /> : x.basis ? <span className="text-fg-dim">({x.basis})</span> : null}
          </li>
        ))}
      </ul>
      <ul className="grid list-disc gap-0.5 pl-5 text-[12px] text-fg-muted">
        {est.assumptions.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </li>
  );
}

type Ranges = Record<AssumptionKey, { low: string; high: string }>;
const pct = (n: number) => String(Math.round(n * 1000) / 10);

function AssumptionsForm({ engagementId, saved, editable }: { engagementId: string; saved: Partial<Record<AssumptionKey, { low: number; high: number }>>; editable: boolean }) {
  const router = useRouter();
  const start = (): Ranges => {
    const out = {} as Ranges;
    for (const k of ASSUMPTION_KEYS) out[k] = { low: pct(saved[k]?.low ?? DEFAULT_ASSUMPTIONS[k].low), high: pct(saved[k]?.high ?? DEFAULT_ASSUMPTIONS[k].high) };
    return out;
  };
  const [ranges, setRanges] = useState<Ranges>(start);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    const overrides: Record<string, { low: number; high: number }> = {};
    for (const k of ASSUMPTION_KEYS) {
      // An emptied box is not 0% (review of phase 3, F9): Number("") is 0.
      if (!String(ranges[k].low).trim() || !String(ranges[k].high).trim()) {
        setMessage(`${DEFAULT_ASSUMPTIONS[k].label}: give both a low and a high.`);
        return;
      }
      const low = Number(ranges[k].low) / 100;
      const high = Number(ranges[k].high) / 100;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high > 1 || low > high) {
        setMessage(`${DEFAULT_ASSUMPTIONS[k].label}: give a low and a high between 0 and 100, the low no higher than the high.`);
        return;
      }
      // Only what differs from the default is kept as CC's own.
      if (low !== DEFAULT_ASSUMPTIONS[k].low || high !== DEFAULT_ASSUMPTIONS[k].high) overrides[k] = { low, high };
    }
    setBusy(true);
    setMessage(null);
    const r = await postAction(engagementId, "save_assumptions", { overrides });
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    setMessage("Saved. The estimates above now use these ranges; the stored research run keeps the ranges it was built with.");
    router.refresh();
  }

  return (
    <div className="grid gap-2">
      <h3 className="text-[13px] font-semibold text-fg">Assumptions</h3>
      <p className="text-[12px] text-fg-muted">Each estimate rests on these ranges. Change one to match what you know about this business; nothing else changes.</p>
      <ul className="grid gap-2">
        {ASSUMPTION_KEYS.map((k) => (
          <li key={k} className="grid gap-1 rounded-lg border border-hairline px-3 py-2">
            <div className="text-fg">{DEFAULT_ASSUMPTIONS[k].label}</div>
            <div className="text-[12px] text-fg-muted">{DEFAULT_ASSUMPTIONS[k].why}</div>
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <label className="flex items-center gap-1">
                <span className="text-fg-muted">Low</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={1}
                  className="w-20 rounded border border-hairline bg-transparent px-2 py-1 tabular-nums text-fg"
                  aria-label={`${DEFAULT_ASSUMPTIONS[k].label}: low, in percent`}
                  value={ranges[k].low}
                  disabled={!editable || busy}
                  onChange={(ev) => setRanges({ ...ranges, [k]: { ...ranges[k], low: ev.target.value } })}
                />
                <span className="text-fg-muted">%</span>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-fg-muted">High</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={1}
                  className="w-20 rounded border border-hairline bg-transparent px-2 py-1 tabular-nums text-fg"
                  aria-label={`${DEFAULT_ASSUMPTIONS[k].label}: high, in percent`}
                  value={ranges[k].high}
                  disabled={!editable || busy}
                  onChange={(ev) => setRanges({ ...ranges, [k]: { ...ranges[k], high: ev.target.value } })}
                />
                <span className="text-fg-muted">%</span>
              </label>
              {saved[k] ? <span className="text-fg-dim">Your range</span> : <span className="text-fg-dim">Default</span>}
            </div>
          </li>
        ))}
      </ul>
      {editable ? (
        <div>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving" : "Save the assumptions"}
          </button>
        </div>
      ) : (
        <div className="text-[12px] text-fg-muted">Only the workspace owner changes the assumptions.</div>
      )}
      <div role="status" aria-live="polite">
        {message ? <div className="rounded-lg border border-hairline px-3 py-2 text-fg">{message}</div> : null}
      </div>
    </div>
  );
}

/** The next step after research: the audit's first draft, then its proposal's. The owner's press only. */
function DraftBox({ view }: { view: EngagementView }) {
  const router = useRouter();
  const e = view.engagement;
  const [busy, setBusy] = useState<"" | "audit" | "proposal" | "prose">("");
  const [message, setMessage] = useState<string | null>(null);
  const auditDraft = view.audit?.status === "draft";
  const proposalDraft = view.proposal?.status === "draft";
  const authorizedEngine = view.authorization?.engine ?? view.settings.engine;
  const modelWritingDeferred = !view.modelSearchEnabled || authorizedEngine === "none";

  async function draft(what: "audit" | "proposal") {
    const exists = what === "audit" ? auditDraft : proposalDraft;
    const ask =
      what === "audit"
        ? "Replace what the audit draft says with a fresh draft from this research? Your edits to the draft will be lost."
        : "Replace the proposal draft with a fresh one from the audit's opportunities? Prices you typed on it will be lost.";
    if (exists && !window.confirm(ask)) return;
    setBusy(what);
    setMessage(null);
    const r = await postAction(e.id, what === "audit" ? "draft_audit" : "draft_proposal", { replace: exists });
    setBusy("");
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    const blocking = typeof r.blocking === "number" ? r.blocking : 0;
    setMessage(
      what === "audit"
        ? `Audit drafted. Read and edit it on the Audit tab${blocking ? `; ${blocking} thing${blocking === 1 ? "" : "s"} must be fixed before it can be submitted` : ""}.`
        : "Proposal drafted. On the Proposal tab, price every line marked as needing your price before you submit.",
    );
    router.refresh();
  }

  const writing = view.research?.writing ?? null;
  const writingNow = !!writing && ["queued", "running", "waiting_runner"].includes(writing.status);
  async function prose() {
    setBusy("prose");
    setMessage(null);
    const r = await postAction(e.id, "write_prose");
    setBusy("");
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    setMessage(r.runs_on === "mac" ? "The opening is being written on CC's Mac. Every sentence is checked against the research before it is kept." : "The opening is being written. Every sentence is checked against the research before it is kept.");
    router.refresh();
  }

  return (
    <div className="grid gap-2 rounded-lg border border-hairline px-3 py-3">
      <h3 className="text-[13px] font-semibold text-fg">Next: the audit and the proposal</h3>
      <p className="text-[12px] text-fg-muted">
        The audit is drafted from this research: its findings, estimates and gaps as they stand, the opportunities they point to, and a roadmap. The proposal starts from the catalogue items those opportunities need; a price comes only from a confirmed catalogue item or from you.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={view.audit ? "btn-secondary" : "btn-primary"} disabled={!!busy} onClick={() => void draft("audit")}>
          {busy === "audit" ? "Drafting" : view.audit ? "Draft the audit again" : "Draft the audit"}
        </button>
        <button type="button" className="btn-secondary" disabled={!!busy || !auditDraft} onClick={() => void draft("proposal")}>
          {busy === "proposal" ? "Drafting" : view.proposal ? "Draft the proposal again" : "Draft the proposal"}
        </button>
        <button type="button" className="btn-secondary" disabled={!!busy || !auditDraft || writingNow || modelWritingDeferred} onClick={() => void prose()}>
          {modelWritingDeferred ? "Model writing deferred" : busy === "prose" ? "Starting" : writingNow ? "Writing the opening" : "Write the opening with AI"}
        </button>
      </div>
      {modelWritingDeferred ? <div className="text-[12px] text-status-warm">The opening stays in the deterministic draft for you to edit. Audit and proposal drafting are still available.</div> : null}
      {writing && !writingNow ? (
        <div className="text-[12px] text-fg-muted">
          {writing.written
            ? `The opening was written ${when(writing.created_at)}.`
            : `The last pass did not change the draft${writing.error ? `: ${WRITE_STOP_WORDS[writing.error] ?? writing.error.replace(/_/g, " ")}` : ""}.`}
          {writing.withheld.length ? ` ${writing.withheld.length} sentence${writing.withheld.length === 1 ? " was" : "s were"} held back:` : ""}
        </div>
      ) : null}
      {writing?.withheld.length ? (
        <ul className="grid list-disc gap-0.5 pl-5 text-[12px] text-fg-muted">
          {writing.withheld.slice(0, 12).map((w, i) => (
            <li key={`${w.part}:${i}`} className="min-w-0 break-words">
              <span className="text-fg">{w.sentence}</span> ({w.reason})
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <div className="rounded-lg border border-hairline px-3 py-2 text-fg">{message}</div> : null}
    </div>
  );
}

export function ResearchPanel({ view, isOwner }: { view: EngagementView; isOwner: boolean }) {
  const router = useRouter();
  const e = view.engagement;
  const r = view.research;
  const step = r?.step ?? null;
  const pack = r?.latest?.content ?? null;
  const running = !!step && IN_FLIGHT.includes(step.status);
  const authorizedEngine = view.authorization?.engine ?? view.settings.engine;
  const modelSearchDeferred = !view.modelSearchEnabled || authorizedEngine === "none";
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // While a run is going, the page looks again every 15 seconds, so its phase and result appear.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(id);
  }, [running, router]);

  async function again() {
    setBusy(true);
    setMessage(null);
    const res = await postAction(e.id, "start_research");
    setBusy(false);
    if (!res.ok) {
      setMessage(describeError(res));
      return;
    }
    setMessage(
      res.created
        ? modelSearchDeferred
          ? "Research started. Website checks, PageSpeed and the evidence rules continue; model search is deferred."
          : "Research started. It moves one step every five minutes; the web search waits for CC's Mac."
        : "A research run is already going.",
    );
    router.refresh();
  }

  if (!r) {
    return (
      <section className="grid gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
        <h2 className="text-sm font-semibold text-fg">Research and evidence</h2>
        <div className="text-fg-muted">Research needs its tables (database migration bravo__243). Nothing has been researched.</div>
      </section>
    );
  }

  const numbers = new Map((pack?.sources ?? []).map((s, i) => [s.id, i + 1]));
  const findings = pack?.findings ?? [];
  const measured = findings.filter((f) => f.label === "verified");
  const said = findings.filter((f) => f.label === "client_reported");
  const likely = findings.filter((f) => f.label === "hypothesis");
  const canRun = isOwner && e.stage === "generating" && !running;

  let status: string;
  if (running) status = `Running: ${PHASE_WORDS[step?.phase ?? ""] ?? "starting"}. Started ${when(step?.created_at)}.`;
  else if (r.latest) status = `Version ${r.latest.version_no}, built ${when(r.latest.created_at)}${r.latest.status === "partial" ? ", with some parts missing (see Gaps)" : ""}.`;
  else if (step && step.status !== "done") status = `The last run did not finish. ${STOP_WORDS[step.error ?? ""] ?? (step.error ? `It stopped (${step.error}).` : "")}`.trim();
  else if (e.stage === "generating") status = "Not run yet. It starts by itself within a few minutes of Gate 1, or press the button.";
  else status = "Research runs after Gate 1, once the client's information is authorized.";

  return (
    <section className="grid gap-4 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-fg">Research and evidence</h2>
          <div className="text-[12px] text-fg-muted">{status}</div>
        </div>
        {canRun ? (
          <button type="button" className={r.latest ? "btn-secondary" : "btn-primary"} disabled={busy} onClick={() => void again()}>
            {busy ? "Starting" : r.latest ? "Research again" : "Start the research"}
          </button>
        ) : null}
      </div>
      <div role="status" aria-live="polite">
        {message ? <div className="rounded-lg border border-hairline px-3 py-2 text-fg">{message}</div> : null}
      </div>
      {modelSearchDeferred ? (
        <div className="rounded-lg border border-hairline px-3 py-2 text-[12px] text-status-warm">
          Model and web search are deferred. Deterministic website checks, PageSpeed, evidence rules, audit and proposal drafting, and PDF printing continue.
        </div>
      ) : null}

      {pack ? (
        <>
          <ul className="grid gap-1 sm:grid-cols-2">
            {pack.plan.map((m) => (
              <li key={m.module} className="flex items-start gap-2">
                <span className="w-32 shrink-0 text-fg">{MODULE_WORDS[m.module] ?? m.module}</span>
                <span className="text-fg-muted">
                  {STATUS_WORDS[m.status] ?? m.status}. {m.detail}
                </span>
              </li>
            ))}
          </ul>

          <FindingList title="Measured and confirmed" items={measured} numbers={numbers} />
          <FindingList title="What the client said" items={said} numbers={numbers} />
          <FindingList title="Likely problems to test" items={likely} numbers={numbers} />

          <div className="grid gap-2">
            <h3 className="text-[13px] font-semibold text-fg">Estimates</h3>
            {r.estimates.length ? (
              <ul className="grid gap-2">
                {r.estimates.map((est) => (
                  <EstimateCard key={est.id} est={est} numbers={numbers} />
                ))}
              </ul>
            ) : (
              <div className="text-fg-muted">None yet: the figures they need are listed under Gaps.</div>
            )}
          </div>

          <AssumptionsForm key={JSON.stringify(r.assumptions)} engagementId={e.id} saved={r.assumptions} editable={isOwner} />

          {isOwner && e.stage === "generating" ? <DraftBox view={view} /> : null}

          {pack.gaps.length ? (
            <div className="grid gap-1">
              <h3 className="text-[13px] font-semibold text-fg">Gaps</h3>
              <ul className="grid list-disc gap-0.5 pl-5 text-fg-muted">
                {pack.gaps.map((g, i) => (
                  <li key={`${g.topic}:${i}`} className="min-w-0 break-words">
                    <span className="text-fg">{g.topic}:</span> {g.why}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pack.evidence_changes.length || pack.search_refused.length ? (
            <details className="text-[12px] text-fg-muted">
              <summary className="cursor-pointer text-fg">What the evidence rules took out ({pack.evidence_changes.length + pack.search_refused.length})</summary>
              <ul className="mt-1 grid list-disc gap-0.5 pl-5">
                {pack.evidence_changes.map((c) => (
                  <li key={`${c.finding_id}:${c.action}`} className="min-w-0 break-words">
                    {c.action === "dropped" ? "Dropped" : "Downgraded to a hypothesis"}
                    {c.title ? <span className="text-fg"> {c.title}</span> : null}: {c.reason}.
                  </li>
                ))}
                {pack.search_refused.map((x, i) => (
                  <li key={`refused:${i}`} className="min-w-0 break-words">
                    Search result refused: {x}.
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {pack.sources.length ? (
            <div className="grid gap-1">
              <h3 className="text-[13px] font-semibold text-fg">Sources</h3>
              <ol className="grid gap-1">
                {pack.sources.map((s, i) => (
                  <li key={s.id} id={`research-source-${i + 1}`} className="grid min-w-0 gap-0.5">
                    <div className="flex items-start gap-2">
                      <span className="w-7 shrink-0 tabular-nums text-fg-dim">[{i + 1}]</span>
                      <span className="min-w-0 break-words">
                        {s.url ? (
                          <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-fg underline decoration-hairline underline-offset-2 hover:decoration-fg">
                            {s.title}
                          </a>
                        ) : (
                          <span className="text-fg">{s.title}</span>
                        )}
                        <span className="text-[12px] text-fg-dim">
                          {" "}
                          read {when(s.retrieved_at)}
                          {s.published_at ? `, published ${when(s.published_at)}` : ""}
                          {RELIABILITY_WORDS[s.reliability] ? `, ${RELIABILITY_WORDS[s.reliability]}` : ""}
                        </span>
                      </span>
                    </div>
                    {s.excerpt ? (
                      <details className="min-w-0 pl-9 text-[12px] text-fg-muted">
                        <summary className="cursor-pointer">What was stored</summary>
                        <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{s.excerpt}</p>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
