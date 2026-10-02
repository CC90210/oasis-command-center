"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Banknote,
  Check,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { errorSentence } from "@/lib/ui/error-copy";
import {
  COMPANY_TRACK_BPS,
  MANAGER_OVERRIDE_BPS,
  SELF_TRACK_BPS,
} from "@/lib/website-sales-comp";
import {
  commissionPartyRoleLabel,
  formatCommissionAmounts,
  type CommissionAmountStatus,
  type WebsiteSalesCommissionSummary,
} from "@/lib/website-sales-commission-summary";
import type {
  CommissionPortalPage,
  CommissionPortalPayload,
  CommissionPortalRow,
  CommissionPortalViewer,
} from "@/lib/website-sales-commission-portal";

type Commission = CommissionPortalRow;

type Editor = { id: string; mode: "paid" | "void" } | null;

const STATUS_STYLE: Record<Commission["status"], string> = {
  accrued: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  approved: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  paid: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  offset: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  voided: "border-bg-border bg-bg-elev text-fg-muted",
};

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: currency === "USD" ? "USD" : "CAD",
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function dateTime(value: string | null): string {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The Commissions portal. It starts with the data the page read on the server
 * (`initial`, lib/website-sales-commission-portal.ts), so its first paint has
 * the numbers and it makes no request when it mounts. It asks the GET route
 * again only when someone presses Refresh or after a payout change.
 *
 * `error` holds a CODE (a route's, or one of the two below for a request that
 * never answered); it is turned into a sentence in exactly one place, where
 * it is drawn (lib/ui/error-copy.ts). The code itself is never on screen.
 */
export function CommissionPortal({ initial }: { initial: CommissionPortalPayload }) {
  const [rows, setRows] = useState<Commission[]>(initial.ok ? initial.data : []);
  const [viewer, setViewer] = useState<CommissionPortalViewer | undefined>(initial.ok ? initial.viewer : undefined);
  const [summary, setSummary] = useState<WebsiteSalesCommissionSummary | null>(initial.ok ? initial.summary : null);
  const [page, setPage] = useState<CommissionPortalPage | undefined>(initial.ok ? initial.page : undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(initial.ok ? null : initial.error);
  const [statusFilter, setStatusFilter] = useState<"all" | Commission["status"]>("all");
  const [editor, setEditor] = useState<Editor>(null);
  const [payoutReference, setPayoutReference] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [workingId, setWorkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/website-sales/commissions", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as CommissionPortalPayload | null;
      if (!response.ok || !payload?.ok || !payload.viewer || !payload.summary || !payload.page) {
        setSummary(null);
        setPage(undefined);
        setError((payload && !payload.ok && payload.error) || "commission_refresh_unavailable");
        return;
      }
      setRows(payload.data ?? []);
      setViewer(payload.viewer);
      setSummary(payload.summary);
      setPage(payload.page);
    } catch {
      setSummary(null);
      setPage(undefined);
      setError("commission_refresh_unavailable");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const filtered = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((row) => row.status === statusFilter)),
    [rows, statusFilter],
  );
  const summaryValue = (statuses: CommissionAmountStatus[]) =>
    summary ? formatCommissionAmounts(summary.totals, statuses) : "—";

  const mutate = useCallback(async (
    row: Commission,
    action: "approve" | "mark_paid" | "void",
  ) => {
    setWorkingId(row.id);
    setError(null);
    try {
      const response = await fetch("/api/website-sales/commissions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          action,
          requestId: crypto.randomUUID(),
          ...(action === "mark_paid" ? { payoutReference } : {}),
          ...(action === "void" ? { voidReason } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        setError(payload?.error || "commission_update_failed");
        return;
      }
      setEditor(null);
      setPayoutReference("");
      setVoidReason("");
      await load();
    } catch {
      setError("commission_update_failed");
    } finally {
      setWorkingId(null);
    }
  }, [load, payoutReference, voidReason]);

  // Nothing has been earned yet (and nothing is listed): one explainer
  // instead of four zero totals and an empty list.
  if (!error && summary && summary.entryCount === 0 && rows.length === 0) {
    return <NoCommissionYet />;
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200" role="alert">
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          <span className="min-w-0 flex-1 break-words">{errorSentence(error)}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="text-rose-200/70 hover:text-rose-100">
            <X size={15} />
          </button>
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Clock3} label="Accrued" value={summaryValue(["accrued"])} hint="Awaiting founder approval" />
        <SummaryCard icon={ShieldCheck} label="Approved" value={summaryValue(["approved"])} hint="Cleared for payout" />
        <SummaryCard icon={Banknote} label="Paid" value={summaryValue(["paid"])} hint="Transfer reference recorded" />
        <SummaryCard
          icon={CircleDollarSign}
          label="Net total"
          value={summaryValue(["accrued", "approved", "paid", "offset"])}
          hint={summary ? `${summary.entryCount} ${summary.entryCount === 1 ? "entry" : "entries"}` : "Totals unavailable"}
        />
      </section>

      <section className="overflow-hidden rounded-xl border border-bg-border bg-bg-panel shadow-card">
        <header className="flex flex-col gap-3 border-b border-bg-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <BadgeCheck size={16} className="text-accent" />
              {viewer?.ledgerScope === "manager_team"
                ? "My team commission ledger"
                : viewer?.isAdmin
                  ? "Team payout ledger"
                  : "My commission ledger"}
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              {viewer?.ledgerScope === "manager_team"
                ? "Includes your own entries and your direct reports only. "
                : ""}
              {page?.hasMore
                ? `Showing the latest ${page.recentReturned} entries plus every accrued or approved payout (${page.outstandingCount} outstanding). Paid and refund filters cover recent history; totals above include all ${summary?.entryCount ?? 0} entries.`
                : "Commission appears only after the full setup payment is verified and the lead enters Won."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              aria-label="Filter commissions by status"
              className="rounded-lg border border-bg-border bg-bg-elev px-3 py-2 text-xs text-fg outline-none focus:border-accent/60"
            >
              <option value="all">All statuses</option>
              <option value="accrued">Accrued</option>
              <option value="approved">Approved</option>
              <option value="paid">Paid</option>
              <option value="offset">Refund offsets</option>
              <option value="voided">Voided</option>
            </select>
            <button
              type="button"
              onClick={() => void load()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elev px-3 py-2 text-xs font-semibold text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </header>

        {rows.length === 0 && !summary ? (
          // The read failed: say so, never "no entries" (an unread list is not an empty one).
          <div className="px-5 py-14 text-center">
            <AlertTriangle className="mx-auto mb-3 text-fg-dim" size={28} />
            <p className="text-sm font-medium text-fg">Entries couldn't be loaded</p>
            <p className="mt-1 text-xs text-fg-muted">Press Refresh to try again.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <CircleDollarSign className="mx-auto mb-3 text-fg-dim" size={28} />
            <p className="text-sm font-medium text-fg">No commission entries in this {page?.hasMore ? "recent " : ""}view</p>
            <p className="mt-1 text-xs text-fg-muted">A fully verified setup payment moves the lead to Won and creates each credited accrual automatically.</p>
          </div>
        ) : (
          <div className="divide-y divide-bg-border">
            {filtered.map((row) => {
              const isOwnCommission = row.repUserId === viewer?.userId;
              const isWorking = workingId === row.id;
              const canApprove = viewer?.canManagePayouts && row.status === "accrued" && row.entryType === "accrual" && row.amountCents > 0 && row.paymentVerified && !isOwnCommission;
              const canPay = viewer?.canManagePayouts && row.status === "approved" && row.entryType === "accrual" && row.amountCents > 0 && row.paymentVerified;
              const canVoid = viewer?.canManagePayouts && (row.status === "accrued" || row.status === "approved") && row.entryType === "accrual" && row.amountCents > 0;
              return (
                <article key={row.id} className="px-4 py-5 transition-colors hover:bg-bg-elev/25">
                  {/* Every track can shrink (minmax(0, ...)), so a row is never wider than
                      the page: the old fixed minimums needed ~1,112px and a 1280px laptop
                      leaves ~968px beside the rail, so the payout buttons were cut off.
                      Five columns from 1440px; below that the payout controls take their
                      own line under the row (two columns on a tablet, one on a phone). */}
                  <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,.9fr)] min-[1440px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,.9fr)_minmax(0,1fr)] min-[1440px]:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {row.leadId ? (
                          <Link href={`/pipeline/${row.leadId}`} className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-semibold text-fg hover:text-accent">
                            <span className="truncate" title={row.clientName}>{row.clientName}</span>
                            <ExternalLink size={12} className="shrink-0" />
                          </Link>
                        ) : (
                          <span className="min-w-0 max-w-full truncate font-semibold text-fg" title={row.clientName}>{row.clientName}</span>
                        )}
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLE[row.status]}`}>
                          {row.status}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-fg-muted">{titleCase(row.packageId || "custom")} package</div>
                      {(viewer?.isAdmin || viewer?.ledgerScope === "manager_team") && (
                        <div className="mt-3 flex items-start gap-2 text-xs text-fg-muted">
                          <UserRound size={13} className="mt-0.5 shrink-0 text-accent" />
                          <div>
                            <div className="font-medium text-fg">{row.repName}</div>
                            {row.repEmail && <div className="mt-0.5 text-[11px] text-fg-dim">{row.repEmail}</div>}
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <FieldLabel>Verified collection</FieldLabel>
                      <div className="mt-1 text-sm font-semibold tabular-nums text-fg">{money(row.collectedAmountCents, row.currency)}</div>
                      <div className="mt-1 text-[11px] text-fg-muted">Full quote {money(row.quotedAmountCents, row.currency)}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                        {row.paymentVerified ? (
                          <><BadgeCheck size={12} className="text-emerald-300" /><span className="text-emerald-300">Verified {titleCase(row.paymentProvider || "payment")}</span></>
                        ) : ["refunded", "voided", "disputed"].includes(row.paymentStatus) ? (
                          <><AlertTriangle size={12} className="text-rose-300" /><span className="text-rose-300">Receipt {titleCase(row.paymentStatus)}</span></>
                        ) : (
                          <><AlertTriangle size={12} className="text-amber-300" /><span className="text-amber-300">Receipt not verified</span></>
                        )}
                      </div>
                      <code className="mt-2 block max-w-full truncate rounded bg-black/20 px-2 py-1 text-[10px] text-fg-dim" title={row.paymentReference}>
                        {row.paymentReference}
                      </code>
                    </div>

                    <div>
                      <FieldLabel>Role & rate</FieldLabel>
                      <div className="mt-1 text-sm font-semibold text-fg">{commissionPartyRoleLabel(row.partyRole, row.rateBps)}</div>
                      <div className="mt-1 text-xs tabular-nums text-fg-muted">{(row.rateBps / 100).toFixed(2)}%</div>
                    </div>

                    <div>
                      <FieldLabel>Commission</FieldLabel>
                      <div className={`mt-1 text-xl font-bold tabular-nums ${row.amountCents < 0 ? "text-rose-300" : "text-fg"}`}>
                        {money(row.amountCents, row.currency)}
                      </div>
                      <div className="mt-1 text-[11px] text-fg-muted">{dateTime(row.effectiveAt)}</div>
                      {row.approvedByName && <div className="mt-1 text-[11px] text-fg-dim">Approved by {row.approvedByName}</div>}
                      {row.payoutReference && (
                        <div className="mt-2 text-[11px] text-emerald-300">Payout: <span className="break-all font-mono">{row.payoutReference}</span></div>
                      )}
                      {row.voidReason && <div className="mt-2 text-[11px] text-fg-muted">Void reason: {row.voidReason}</div>}
                    </div>

                    <div className="md:col-span-2 xl:col-span-4 min-[1440px]:col-span-1">
                      <FieldLabel>{viewer?.canManagePayouts ? "Founder controls" : "Payout state"}</FieldLabel>
                      {!viewer?.canManagePayouts && (
                        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
                          {row.status === "accrued" ? "Awaiting founder approval." : row.status === "approved" ? "Approved and waiting for payout." : row.status === "paid" ? `Paid ${dateTime(row.paidAt)}.` : `This entry is ${row.status}.`}
                        </p>
                      )}
                      {viewer?.canManagePayouts && (
                        <div className="mt-2 space-y-2 md:max-w-sm min-[1440px]:max-w-none">
                          {row.status === "accrued" && row.entryType === "accrual" && row.amountCents > 0 && (
                            <>
                              <button
                                type="button"
                                disabled={!canApprove || isWorking}
                                onClick={() => void mutate(row, "approve")}
                                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {isWorking ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                                Approve accrual
                              </button>
                              {isOwnCommission && <p className="text-[11px] text-amber-300">Another founder must approve your commission.</p>}
                              {!row.paymentVerified && <p className="text-[11px] text-amber-300">A verified payment receipt is required.</p>}
                              {canVoid && editor?.id !== row.id && (
                                <button type="button" onClick={() => { setEditor({ id: row.id, mode: "void" }); setVoidReason(""); }} className="w-full rounded-lg border border-rose-400/30 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-400/10">
                                  Void accrual
                                </button>
                              )}
                            </>
                          )}
                          {canPay && editor?.id !== row.id && (
                            <button type="button" onClick={() => { setEditor({ id: row.id, mode: "paid" }); setPayoutReference(""); }} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-400">
                              <Banknote size={13} /> Mark as paid
                            </button>
                          )}
                          {row.status === "approved" && canVoid && editor?.id !== row.id && (
                            <button type="button" onClick={() => { setEditor({ id: row.id, mode: "void" }); setVoidReason(""); }} className="w-full rounded-lg border border-rose-400/30 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-400/10">
                              Void accrual
                            </button>
                          )}
                          {row.status === "paid" && <p className="text-xs text-emerald-300">Paid · final</p>}
                          {row.entryType === "refund_offset" && <p className="text-xs text-rose-300">Refund offset · immutable</p>}
                          {row.entryType === "manual_adjustment" && <p className="text-xs text-fg-muted">Manual adjustment · read-only</p>}
                          {row.status === "voided" && <p className="text-xs text-fg-muted">Voided · final</p>}
                          {row.status === "approved" && !canPay && <p className="text-xs text-fg-muted">Approved payout</p>}
                        </div>
                      )}
                    </div>
                  </div>

                  {editor?.id === row.id && editor.mode === "paid" && (
                    <div className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-4">
                      <label className="block text-xs font-semibold text-fg" htmlFor={`payout-${row.id}`}>Payout reference</label>
                      <p className="mt-1 text-[11px] text-fg-muted">Enter the bank, e-transfer, payroll, or batch reference after the money has actually been sent.</p>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input id={`payout-${row.id}`} value={payoutReference} onChange={(event) => setPayoutReference(event.target.value)} maxLength={200} placeholder="e.g. eTransfer-2026-08-24-0042" className="min-w-0 flex-1 rounded-lg border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg outline-none focus:border-emerald-400/60" />
                        <button type="button" disabled={payoutReference.trim().length < 3 || isWorking} onClick={() => void mutate(row, "mark_paid")} className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">Confirm paid</button>
                        <button type="button" onClick={() => setEditor(null)} className="rounded-lg border border-bg-border px-3 py-2 text-xs font-semibold text-fg-muted">Cancel</button>
                      </div>
                    </div>
                  )}

                  {editor?.id === row.id && editor.mode === "void" && (
                    <div className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/5 p-4">
                      <label className="block text-xs font-semibold text-fg" htmlFor={`void-${row.id}`}>Reason for voiding</label>
                      <p className="mt-1 text-[11px] text-fg-muted">This is permanent. Use a specific, auditable reason; refunds are handled as separate offset rows.</p>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input id={`void-${row.id}`} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} maxLength={500} placeholder="e.g. Duplicate attribution confirmed against signed deal" className="min-w-0 flex-1 rounded-lg border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg outline-none focus:border-rose-400/60" />
                        <button type="button" disabled={voidReason.trim().length < 8 || isWorking} onClick={() => void mutate(row, "void")} className="rounded-lg bg-rose-500 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">Confirm void</button>
                        <button type="button" onClick={() => setEditor(null)} className="rounded-lg border border-bg-border px-3 py-2 text-xs font-semibold text-fg-muted">Cancel</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">{children}</div>;
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel p-4 shadow-card">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
        <Icon size={13} className="text-accent" /> {label}
      </div>
      <div className="mt-2 text-xl font-bold tabular-nums text-fg">{value}</div>
      <div className="mt-1 text-xs text-fg-dim">{hint}</div>
    </div>
  );
}

/** A whole percent from basis points. The rates come from the comp engine, never typed here. */
function percent(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}

/**
 * Shown instead of four zero totals and an empty list while nothing has been
 * earned in this view. The rates are lib/website-sales-comp.ts's own: the
 * numbers the payout runs on and the agreements state.
 */
function NoCommissionYet() {
  const rates = [
    { role: "You open it", rate: percent(COMPANY_TRACK_BPS.opener), detail: "You book the meeting and someone else closes." },
    { role: "You close it", rate: percent(COMPANY_TRACK_BPS.closer), detail: "You close a lead the company brought in." },
    { role: "You find and close it", rate: percent(SELF_TRACK_BPS.open_close), detail: "You found the client yourself and closed it." },
    { role: "You do all of it", rate: percent(SELF_TRACK_BPS.full_stack), detail: "You found it, closed it and built the website." },
  ];
  return (
    <section className="rounded-xl border border-bg-border bg-bg-panel p-5 shadow-card">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <CircleDollarSign size={16} className="text-accent" />
        No commission yet
      </div>
      <p className="mt-2 text-sm text-fg-muted">
        Commission appears here once a client&apos;s setup payment is confirmed. It is a share of that setup payment, set by the part you played:
      </p>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rates.map((r) => (
          <div key={r.role} className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
            <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">{r.role}</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-fg">{r.rate}</dd>
            <dd className="mt-1 text-xs text-fg-muted">{r.detail}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-fg-dim">
        A manager also earns {percent(MANAGER_OVERRIDE_BPS)} of what OASIS keeps from their team&apos;s deals.
      </p>
    </section>
  );
}
