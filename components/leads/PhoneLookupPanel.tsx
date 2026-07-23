"use client";

/**
 * PhoneLookupPanel — the AUTOMATED (TruePeopleSearch) phone lookup, which is
 * step one of merchant contact enrichment and sits directly above the CLAIR
 * panel that is its paid fallback.
 *
 * WHY THE RESULT ARRIVES ASYNCHRONOUSLY:
 * The lookup cannot run in the Vercel function this button calls. The source
 * site is DataDome-protected and scores the origin ASN before parsing the
 * request, so every datacenter IP is challenged — the VPS and Vercel alike. The
 * scrape therefore runs on Adon's workstation (residential IP, stealth browser),
 * which nothing on the internet can call inbound. Clicking enqueues a job; the
 * local worker picks it up and writes the answer back. This component polls
 * until the row reaches a terminal status, which is why there is a "queued"
 * state at all and why that state is explained to the operator rather than
 * hidden behind an indefinite spinner.
 *
 * The panel deliberately does NOT hide itself once a number is found: the
 * lookup history is the provenance of the phone number now sitting on the lead,
 * and an operator calling that number is entitled to see where it came from and
 * how confident the match was.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, PhoneOff, RefreshCw, Search, Smartphone } from "lucide-react";

import { copyText } from "@/lib/clipboard";
import { hasUsablePhone } from "@/lib/clair/eligibility";

type JobStatus = "pending" | "running" | "completed" | "no_results" | "blocked" | "error";

type Phone = { number?: string; type?: string | null };

type Job = {
  id: string;
  status: JobStatus;
  error_message: string | null;
  phones: Phone[] | null;
  matched_name: string | null;
  matched_age: number | null;
  matched_city: string | null;
  matched_state: string | null;
  confidence: number | null;
  source: string | null;
  query_first_name: string | null;
  query_last_name: string | null;
  query_city: string | null;
  query_state: string | null;
  requested_by_email: string | null;
  created_at: string;
  completed_at: string | null;
};

const IN_FLIGHT: ReadonlySet<JobStatus> = new Set(["pending", "running"]);

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** '+17722818115' -> '(772) 281-8115'. Falls back to the raw value rather than
 * hiding a number we failed to format. */
function fmtPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  const n = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (n.length !== 10) return raw;
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

function isMobile(type: string | null | undefined): boolean {
  return /wireless|mobile|cell/i.test(type || "");
}

function PhoneRow({ phone, primary }: { phone: Phone; primary: boolean }) {
  const [copied, setCopied] = useState(false);
  const number = String(phone.number || "");
  if (!number) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-elev/30 px-2.5 py-1.5">
      <Smartphone
        className={`h-3.5 w-3.5 shrink-0 ${isMobile(phone.type) ? "text-status-good" : "text-fg-dim"}`}
      />
      <span className="font-mono text-[12px] text-fg">{fmtPhone(number)}</span>
      {phone.type && (
        <span className="text-[10px] uppercase tracking-wider text-fg-dim">{phone.type}</span>
      )}
      {primary && (
        <span className="rounded-full border border-status-good/40 bg-status-good/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-status-good">
          On file
        </span>
      )}
      <button
        type="button"
        onClick={async () => {
          if (await copyText(number)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold text-fg-dim hover:bg-bg-elev hover:text-fg"
        aria-label={`Copy ${fmtPhone(number)}`}
      >
        {copied ? <Check className="h-3 w-3 text-status-good" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function PhoneLookupPanel({
  leadId,
  leadData,
  onChanged,
}: {
  leadId: string;
  /** The flattened lead data object — same value ClairReportPanel receives. */
  leadData: Record<string, unknown>;
  onChanged?: () => void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set once a poll observes a terminal status, so the parent refreshes the
   * lead record exactly once rather than on every poll tick. */
  const settled = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/leads/${leadId}/phone-lookup`, { cache: "no-store" });
      const j = await r.json();
      if (j?.ok) setJobs(j.jobs as Job[]);
    } catch {
      /* transient fetch failure — the next poll retries; never blank the panel */
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = jobs?.[0] ?? null;
  const inFlight = Boolean(latest && IN_FLIGHT.has(latest.status));

  // Poll only while the worker owns the row. A completed job is final, so
  // polling past it would be pure noise against the API.
  useEffect(() => {
    if (!inFlight) {
      // The run just finished: pull the lead record through so the summary chip
      // and any newly-stamped phone appear without a tab switch.
      if (latest && !settled.current) {
        settled.current = true;
        onChanged?.();
      }
      return;
    }
    settled.current = false;
    timer.current = setTimeout(() => void load(), 4000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [inFlight, latest, load, onChanged]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/phone-lookup`, { method: "POST" });
      const j = await r.json();
      if (!j?.ok) {
        setError(j?.message || j?.error || "Could not start the lookup.");
      } else {
        settled.current = false;
        await load();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setStarting(false);
    }
  }, [leadId, load]);

  const alreadyHasPhone = hasUsablePhone(leadData);
  const hasHistory = Boolean(jobs && jobs.length);

  // Loading the history for the first time — say nothing rather than flash an
  // affordance that may be about to be replaced by a result.
  if (jobs === null) return null;
  // No phone problem and no history: this lead never needed enrichment.
  if (alreadyHasPhone && !hasHistory) return null;

  const phones = (latest?.phones ?? []).filter((p) => p?.number);
  const onFile = String(leadData.phone ?? "").replace(/\D/g, "");

  return (
    <div className="mt-5 border-t border-bg-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-fg-dim">
          Phone lookup
        </h4>
        <span className="rounded-full border border-bg-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-dim">
          Automated · first step
        </span>
        {latest && (
          <span className="text-[11px] text-fg-dim">last run {fmtWhen(latest.created_at)}</span>
        )}
      </div>

      <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
        {alreadyHasPhone
          ? "This lead has a number on file. The history below shows where it came from."
          : "Searches public people-search records for this owner's phone number. Free, and always run before a billable CLAIR report."}
      </p>

      {!alreadyHasPhone && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting || inFlight}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-[11px] font-bold text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {starting || inFlight ? (
              <>
                <RefreshCw className="h-3 w-3 animate-spin" />
                {inFlight ? "Searching…" : "Starting…"}
              </>
            ) : (
              <>
                <Search className="h-3 w-3" />
                {hasHistory ? "Search again" : "Find phone number"}
              </>
            )}
          </button>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-status-warm/40 bg-status-warm/5 p-3 text-[12px] text-status-warm">
          {error}
        </div>
      )}

      {/* The queue is visible on purpose: the operator should understand that a
          real browser is doing this on a workstation, not that the app hung. */}
      {inFlight && (
        <div className="mt-3 rounded-lg border border-bg-border bg-bg-elev/30 p-3 text-[12px] text-fg-muted">
          {latest?.status === "pending"
            ? "Queued. The search runs on the local workstation, which is the only machine the source site will accept — it starts within a minute."
            : "Searching public records now. This usually takes under a minute."}
        </div>
      )}

      {latest?.status === "completed" && phones.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-dim">
            <span>
              Matched <span className="text-fg-muted">{latest.matched_name}</span>
              {latest.matched_age ? `, ${latest.matched_age}` : ""}
              {latest.matched_city ? ` — ${latest.matched_city}, ${latest.matched_state}` : ""}
            </span>
            {latest.confidence != null && (
              <span className="rounded-full border border-bg-border px-1.5 py-0.5">
                {latest.confidence}% confidence
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {phones.map((p, i) => (
              <PhoneRow
                key={`${p.number}-${i}`}
                phone={p}
                primary={Boolean(onFile) && String(p.number).replace(/\D/g, "") === onFile}
              />
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-fg-dim">
            Mobile numbers are listed first and the top one was written to the lead. Verify before
            calling — a people-search match is a strong lead, not proof of identity.
          </p>
        </div>
      )}

      {latest?.status === "no_results" && (
        <div className="mt-3 rounded-lg border border-bg-border bg-bg-elev/30 p-3 text-[12px] text-fg-muted">
          <PhoneOff className="mr-1.5 inline h-3.5 w-3.5" />
          The search ran and found no usable number for{" "}
          {latest.query_first_name} {latest.query_last_name}
          {latest.query_state ? ` in ${latest.query_state}` : ""}. A CLAIR report is now available
          below.
        </div>
      )}

      {(latest?.status === "blocked" || latest?.status === "error") && (
        <div className="mt-3 rounded-lg border border-status-warm/40 bg-status-warm/5 p-3 text-[12px] text-status-warm">
          {latest.status === "blocked"
            ? "The source site blocked the automated search, so this is not an answer about the merchant — it is a failed lookup. Try again later, or run a CLAIR report below."
            : `The lookup failed before it could produce an answer${
                latest.error_message ? `: ${latest.error_message}` : "."
              } Try again, or run a CLAIR report below.`}
        </div>
      )}
    </div>
  );
}
