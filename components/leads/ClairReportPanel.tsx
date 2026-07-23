"use client";

/**
 * ClairReportPanel — the CLAIR (Thomson Reuters CLEAR) fallback, on a lead.
 *
 * TWO DELIBERATE CONSTRAINTS, both compliance-shaped rather than cosmetic:
 *
 * 1. STRICT FALLBACK. The "Pull CLAIR Report" button renders ONLY when the
 *    automated TruePeopleSearch path has already run and failed to produce a
 *    number. Before the automated lookup has run, or once it has succeeded,
 *    there is no button at all — CLAIR is billable and every query asserts a
 *    DPPA/GLB permissible use, so it is never the first thing tried. The same
 *    predicate is enforced server-side in the route (409 clair_not_applicable);
 *    this is the visible half of one rule, not the rule itself.
 *
 * 2. TOTAL DATA SEPARATION. Everything here reads from the clair_reports table
 *    via /api/leads/[id]/clair-report. Nothing in this component writes to, or
 *    renders alongside, the application form data. A CLEAR report is reference
 *    material an operator reads to find a phone number — copying a number onto
 *    the lead stays a separate, explicit act through the existing set-field
 *    path, so the vendor payload can never silently become application data.
 */

import { useCallback, useEffect, useState } from "react";
import {
  FileSearch,
  RefreshCw,
  X,
  AlertCircle,
  Phone,
  ChevronRight,
} from "lucide-react";
import { clairEligibility } from "@/lib/clair/eligibility";

type ClairPhone = {
  number?: string;
  type?: string | null;
  carrier?: string | null;
  last_seen?: string | null;
  person?: string | null;
};

type ClairPerson = {
  name?: string | null;
  age?: string | null;
  dob?: string | null;
  entity_id?: string | null;
  addresses?: string[];
  phones?: ClairPhone[];
};

type ClairReport = {
  id: string;
  status: "pending" | "completed" | "no_results" | "error";
  error_message: string | null;
  result_count: number | null;
  people: ClairPerson[] | null;
  phones: ClairPhone[] | null;
  query_name: string | null;
  query_city: string | null;
  query_state: string | null;
  query_dob: string | null;
  permissible_dppa: string | null;
  permissible_glb: string | null;
  permissible_voter: string | null;
  clear_environment: string | null;
  requested_by_email: string | null;
  created_at: string;
  completed_at: string | null;
};

function fmtPhone(n?: string): string {
  const d = (n ?? "").replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n ?? "—";
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function ClairReportPanel({
  leadId,
  leadData,
  onChanged,
}: {
  leadId: string;
  leadData: Record<string, unknown>;
  // Fired after a report is pulled, so a host (the Enrichment tab's pinned
  // summary) can refresh its phone-availability view.
  onChanged?: () => void;
}) {
  const [reports, setReports] = useState<ClairReport[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same predicate the API route enforces — imported, not re-implemented.
  const applies = clairEligibility(leadData).eligible;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/${leadId}/clair-report`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setReports(json.reports ?? []);
    } catch {
      /* a failed history read must not break the lead drawer */
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pull = useCallback(async () => {
    setPulling(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/clair-report`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) {
        setError(json.message || json.error || "CLAIR lookup failed");
      } else {
        setOpen(true);
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "CLAIR lookup failed");
    } finally {
      setPulling(false);
    }
  }, [leadId, load, onChanged]);

  const latest = reports?.[0] ?? null;
  const hasHistory = Boolean(reports && reports.length > 0);

  // Nothing to show and nothing to offer — render nothing at all rather than an
  // empty affordance the operator cannot act on.
  if (!applies && !hasHistory) return null;

  return (
    <div className="mt-5 border-t border-bg-border pt-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-fg-dim">
          CLAIR
        </h4>
        <span className="text-[10px] uppercase tracking-wider rounded-full border border-bg-border text-fg-dim px-1.5 py-0.5">
          Manual fallback
        </span>
        {latest && (
          <span className="text-[11px] text-fg-dim">
            last pulled {fmtWhen(latest.created_at)}
          </span>
        )}
      </div>

      <p className="mt-1.5 text-[12px] text-fg-muted leading-relaxed">
        {applies
          ? "The automated lookup could not produce a number for this merchant. A CLAIR report is a billable, permissible-use query — run it only when you intend to use the result."
          : "Reports previously pulled for this lead."}
      </p>

      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        {applies && (
          <button
            type="button"
            onClick={() => void pull()}
            disabled={pulling}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-[11px] font-bold text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {pulling ? (
              <>
                <RefreshCw className="w-3 h-3 animate-spin" /> Pulling CLAIR report…
              </>
            ) : (
              <>
                <FileSearch className="w-3 h-3" /> Pull CLAIR Report
              </>
            )}
          </button>
        )}
        {hasHistory && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev/50 px-2.5 py-1 text-[11px] font-bold text-fg-muted hover:bg-bg-elev hover:text-fg"
          >
            View report{reports && reports.length > 1 ? `s (${reports.length})` : ""}
            <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>

      {pulling && (
        <div className="mt-3 space-y-1.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 rounded bg-bg-elev/60 animate-pulse" style={{ width: `${80 - i * 18}%` }} />
          ))}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-2.5 flex items-start gap-2 rounded-md border border-status-warm/40 bg-status-warm/5 px-2.5 py-2 text-[11px] text-status-warm"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
          <span className="leading-relaxed">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto text-fg-dim hover:text-fg"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {open && reports && (
        <ClairDrawer reports={reports} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/**
 * The isolated report view. A slide-out over the drawer, reading exclusively
 * from clair_reports — no application fields are rendered here, and nothing in
 * it writes anywhere.
 */
function ClairDrawer({
  reports,
  onClose,
}: {
  reports: ClairReport[];
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(reports[0]?.id);
  const report = reports.find((r) => r.id === selectedId) ?? reports[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!report) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="CLAIR report">
      <button
        type="button"
        aria-label="Close CLAIR report"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-[1px]"
      />
      <div className="relative h-full w-full max-w-xl overflow-y-auto border-l border-bg-border bg-bg-deep shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-bg-border bg-bg-deep/95 px-4 py-3 backdrop-blur">
          <FileSearch className="w-4 h-4 text-accent" />
          <div className="text-sm font-bold text-fg">CLAIR Report</div>
          <span className="text-[10px] uppercase tracking-wider rounded-full border border-bg-border text-fg-dim px-1.5 py-0.5">
            reference only
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-fg-dim hover:bg-bg-elev hover:text-fg"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {reports.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {reports.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    r.id === report.id
                      ? "border-accent/60 bg-accent/10 text-fg"
                      : "border-bg-border bg-bg-elev/50 text-fg-muted hover:text-fg"
                  }`}
                >
                  {fmtWhen(r.created_at)}
                </button>
              ))}
            </div>
          )}

          {/* Provenance — what was asked, under which permissible use, by whom.
              This is the legal record of the query, not decoration. */}
          <section className="rounded-lg border border-bg-border bg-bg-elev/30 p-3">
            <div className="text-[9.5px] uppercase tracking-wider text-fg-dim mb-2">Query</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
              <dt className="text-fg-dim">Subject</dt>
              <dd className="text-fg">{report.query_name || "—"}</dd>
              <dt className="text-fg-dim">Location</dt>
              <dd className="text-fg">
                {[report.query_city, report.query_state].filter(Boolean).join(", ") || "—"}
              </dd>
              <dt className="text-fg-dim">DOB</dt>
              <dd className="text-fg">{report.query_dob || "not supplied"}</dd>
              <dt className="text-fg-dim">Permissible use</dt>
              <dd className="text-fg font-mono text-[11px]">
                DPPA {report.permissible_dppa ?? "—"} · GLB {report.permissible_glb ?? "—"} · VOTER{" "}
                {report.permissible_voter ?? "—"}
              </dd>
              <dt className="text-fg-dim">Run by</dt>
              <dd className="text-fg">
                {report.requested_by_email || "—"}
                {report.clear_environment ? ` · ${report.clear_environment}` : ""}
              </dd>
            </dl>
          </section>

          {report.status === "error" && (
            <div className="rounded-lg border border-status-warm/40 bg-status-warm/5 p-3 text-[12px] text-status-warm">
              <div className="font-bold mb-1">CLEAR returned an error</div>
              <div className="leading-relaxed">{report.error_message || "unknown error"}</div>
            </div>
          )}

          {report.status === "no_results" && (
            <div className="rounded-lg border border-bg-border bg-bg-elev/30 p-3 text-[12px] text-fg-muted">
              CLEAR ran successfully but matched no one for these criteria.
            </div>
          )}

          {/* Every distinct number across the report — the reason this is run. */}
          {report.phones && report.phones.length > 0 && (
            <section>
              <div className="text-[9.5px] uppercase tracking-wider text-fg-dim mb-1.5">
                Phone numbers found
              </div>
              <ul className="space-y-1.5">
                {report.phones.map((p, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-3 flex-wrap rounded-md border border-bg-border bg-bg-elev/30 px-2.5 py-1.5 text-[12px]"
                  >
                    <Phone className="w-3 h-3 text-fg-dim shrink-0" />
                    <span className="font-mono text-fg select-all">{fmtPhone(p.number)}</span>
                    {p.type && <span className="text-[11px] text-fg-muted">{p.type}</span>}
                    {p.carrier && <span className="text-[11px] text-fg-dim">{p.carrier}</span>}
                    {p.person && <span className="text-[11px] text-fg-dim">{p.person}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-fg-dim leading-relaxed">
                Copy a number into the lead&apos;s Phone field to use it. It is not applied
                automatically — CLAIR data stays separate from the application record.
              </p>
            </section>
          )}

          {report.people && report.people.length > 0 && (
            <section>
              <div className="text-[9.5px] uppercase tracking-wider text-fg-dim mb-1.5">
                Matched people ({report.people.length})
              </div>
              <div className="space-y-2">
                {report.people.map((person, i) => (
                  <div key={i} className="rounded-lg border border-bg-border bg-bg-elev/30 p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium text-fg">{person.name || "—"}</span>
                      {person.age && <span className="text-[11px] text-fg-dim">age {person.age}</span>}
                      {person.dob && <span className="text-[11px] text-fg-dim">DOB {person.dob}</span>}
                    </div>
                    {person.addresses && person.addresses.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 text-[12px] text-fg-muted">
                        {person.addresses.map((a, j) => (
                          <li key={j}>{a}</li>
                        ))}
                      </ul>
                    )}
                    {person.phones && person.phones.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {person.phones.map((p, j) => (
                          <span key={j} className="font-mono text-[12px] text-fg select-all">
                            {fmtPhone(p.number)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
