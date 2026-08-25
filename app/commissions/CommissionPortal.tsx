"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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

type Commission = {
  id: string;
  dealId: string;
  leadId: string | null;
  clientName: string;
  packageId: string | null;
  currency: "CAD" | "USD";
  repUserId: string;
  repName: string;
  repEmail: string | null;
  partyRole: string;
  paymentReference: string;
  paymentProvider: "stripe" | "manual" | null;
  paymentStatus: string;
  paymentVerified: boolean;
  paymentVerifiedAt: string | null;
  quotedAmountCents: number;
  collectedAmountCents: number;
  rateBps: number;
  amountCents: number;
  status: "accrued" | "approved" | "paid" | "offset" | "voided";
  entryType: "accrual" | "refund_offset" | "manual_adjustment";
  approvedByName: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  payoutReference: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  effectiveAt: string;
};

type PortalResponse = {
  ok: boolean;
  error?: string;
  viewer?: {
    userId: string;
    isAdmin: boolean;
    canManagePayouts: boolean;
  };
  data?: Commission[];
};

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

function totalsFor(rows: Commission[], statuses: Commission["status"][]): string {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!statuses.includes(row.status)) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountCents);
  }
  if (totals.size === 0) return money(0, "CAD");
  return [...totals.entries()].map(([currency, cents]) => money(cents, currency)).join(" + ");
}

export function CommissionPortal() {
  const [rows, setRows] = useState<Commission[]>([]);
  const [viewer, setViewer] = useState<PortalResponse["viewer"]>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | Commission["status"]>("all");
  const [editor, setEditor] = useState<Editor>(null);
  const [payoutReference, setPayoutReference] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [workingId, setWorkingId] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/website-sales/commissions", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as PortalResponse | null;
      if (!response.ok || !payload?.ok || !payload.viewer) {
        throw new Error(payload?.error || "Unable to load the commission ledger.");
      }
      setRows(payload.data ?? []);
      setViewer(payload.viewer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load the commission ledger.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((row) => row.status === statusFilter)),
    [rows, statusFilter],
  );

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
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || "The payout update failed.");
      setEditor(null);
      setPayoutReference("");
      setVoidReason("");
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The payout update failed.");
    } finally {
      setWorkingId(null);
    }
  }, [load, payoutReference, voidReason]);

  if (loading) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-panel p-12 text-center text-sm text-fg-muted">
        <Loader2 className="mx-auto mb-3 animate-spin text-accent" size={22} />
        Loading the live Turso commission ledger…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200" role="alert">
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="text-rose-200/70 hover:text-rose-100">
            <X size={15} />
          </button>
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Clock3} label="Accrued" value={totalsFor(rows, ["accrued"])} hint="Awaiting founder approval" />
        <SummaryCard icon={ShieldCheck} label="Approved" value={totalsFor(rows, ["approved"])} hint="Cleared for payout" />
        <SummaryCard icon={Banknote} label="Paid" value={totalsFor(rows, ["paid"])} hint="Transfer reference recorded" />
        <SummaryCard icon={CircleDollarSign} label="Net ledger" value={totalsFor(rows, ["accrued", "approved", "paid", "offset"])} hint={`${rows.length} ledger ${rows.length === 1 ? "entry" : "entries"}`} />
      </section>

      <section className="overflow-hidden rounded-xl border border-bg-border bg-bg-panel shadow-card">
        <header className="flex flex-col gap-3 border-b border-bg-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <BadgeCheck size={16} className="text-accent" />
              {viewer?.isAdmin ? "Team payout ledger" : "My commission ledger"}
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              Commission appears only after the collected payment is verified against the closed deal.
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
              onClick={() => void load(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elev px-3 py-2 text-xs font-semibold text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </header>

        {filtered.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <CircleDollarSign className="mx-auto mb-3 text-fg-dim" size={28} />
            <p className="text-sm font-medium text-fg">No commission entries in this view</p>
            <p className="mt-1 text-xs text-fg-muted">A verified collected payment creates the ledger entry automatically.</p>
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
                  <div className="grid gap-5 xl:grid-cols-[minmax(220px,1.3fr)_minmax(210px,1fr)_minmax(170px,.8fr)_minmax(180px,.9fr)_minmax(220px,1fr)] xl:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {row.leadId ? (
                          <Link href={`/pipeline/${row.leadId}`} className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-fg hover:text-accent">
                            <span className="truncate">{row.clientName}</span>
                            <ExternalLink size={12} className="shrink-0" />
                          </Link>
                        ) : (
                          <span className="font-semibold text-fg">{row.clientName}</span>
                        )}
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLE[row.status]}`}>
                          {row.status}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-fg-muted">Deal {row.dealId.slice(0, 12)} · {titleCase(row.packageId || "custom")}</div>
                      {viewer?.isAdmin && (
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
                      <div className="mt-1 text-sm font-semibold text-fg">{titleCase(row.partyRole)}</div>
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
                        <div className="mt-2 text-[11px] text-emerald-300">Payout: <span className="font-mono">{row.payoutReference}</span></div>
                      )}
                      {row.voidReason && <div className="mt-2 text-[11px] text-fg-muted">Void reason: {row.voidReason}</div>}
                    </div>

                    <div>
                      <FieldLabel>{viewer?.canManagePayouts ? "Founder controls" : "Payout state"}</FieldLabel>
                      {!viewer?.canManagePayouts && (
                        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
                          {row.status === "accrued" ? "Awaiting founder approval." : row.status === "approved" ? "Approved and waiting for payout." : row.status === "paid" ? `Paid ${dateTime(row.paidAt)}.` : `This entry is ${row.status}.`}
                        </p>
                      )}
                      {viewer?.canManagePayouts && (
                        <div className="mt-2 space-y-2">
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
