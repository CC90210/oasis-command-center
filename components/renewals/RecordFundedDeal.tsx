"use client";

/**
 * RecordFundedDeal — manual funded-deal entry, the intake behind the Renewals tab.
 *
 * Phase 1 of activating renewals. The tab itself has been built and wired for a
 * while; it had nothing to show because nothing ever wrote a funded deal. This
 * is that write path.
 *
 * Deliberately five fields plus two optional ones. The operator does NOT enter a
 * renewal date or a commission figure — both are derived server-side from the
 * term and the points, so they cannot drift and nobody has to remember to
 * update them. The preview below the form shows what will be computed, so the
 * derivation is visible rather than magic.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import { CalendarPlus, Loader2, Check } from "lucide-react";
import { nextRenewalDate, estCommissionUsd } from "@/lib/renewals/derive";

type FieldErrors = Record<string, string>;

const EMPTY = {
  merchant_name: "",
  contact_name: "",
  lender_name: "",
  funded_amount_usd: "",
  term_months: "",
  factor_rate: "",
  points_pct: "",
  funded_at: "",
  notes: "",
};

const inputCls =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg " +
  "placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent";
const labelCls = "block text-[11px] uppercase tracking-[0.12em] text-fg-muted font-bold mb-1.5";

function toNum(v: string): number | null {
  const cleaned = v.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export default function RecordFundedDeal() {
  const router = useRouter();
  const [form, setForm] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Armed when the server flags a possible duplicate; the next submit overrides. */
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((prev) => (prev[k] ? { ...prev, [k]: "" } : prev));
    // Editing after a duplicate warning means this may no longer be the same
    // deal — re-arm the check rather than carrying a stale override.
    setConfirmDuplicate(false);
  };

  // Live preview of the two derived fields, using the SAME functions the server
  // uses — so what the operator sees here is what gets stored, not an estimate.
  const termNum = toNum(form.term_months);
  const previewRenewal = nextRenewalDate(form.funded_at || null, termNum);
  const previewCommission = estCommissionUsd(toNum(form.funded_amount_usd), toNum(form.points_pct));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/renewals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Carry the operator's "yes, really" through on the second submit.
        body: JSON.stringify({ ...form, confirm_duplicate: confirmDuplicate }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        if (json?.errors) setErrors(json.errors as FieldErrors);
        // A flagged duplicate is a question, not a rejection — arm the next
        // submit to go through rather than making the operator find a workaround.
        if (res.status === 409 && json?.error === "possible_duplicate") {
          setConfirmDuplicate(true);
        }
        setFormError(
          json?.message ||
            (res.status === 403
              ? "You don't have permission to record funded deals."
              : json?.errors
                ? "Please fix the highlighted fields."
                : "Could not save the funded deal."),
        );
        return;
      }
      setSaved(json.deal?.merchant_name || form.merchant_name);
      setForm({ ...EMPTY });
      setConfirmDuplicate(false);
      // The tab is a server component reading funded_deals — refresh so the new
      // row and the recalculated summary tiles appear without a manual reload.
      router.refresh();
    } catch {
      setFormError("Network error — the deal was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-4">
        <CalendarPlus size={12} className="text-accent" />
        <span>Record a funded deal</span>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className={labelCls} htmlFor="fd-merchant">Deal / merchant name *</label>
            <input
              id="fd-merchant" className={inputCls} value={form.merchant_name}
              onChange={set("merchant_name")} placeholder="Remington Builders LLC"
              aria-invalid={!!errors.merchant_name} required
            />
            {errors.merchant_name && <p className="mt-1 text-xs text-status-hot">{errors.merchant_name}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-amount">Amount funded *</label>
            <input
              id="fd-amount" className={inputCls} value={form.funded_amount_usd}
              onChange={set("funded_amount_usd")} placeholder="85,000" inputMode="decimal"
              aria-invalid={!!errors.funded_amount_usd} required
            />
            {errors.funded_amount_usd && <p className="mt-1 text-xs text-status-hot">{errors.funded_amount_usd}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-funded-at">Funded date *</label>
            <input
              id="fd-funded-at" type="date" className={inputCls} value={form.funded_at}
              onChange={set("funded_at")} aria-invalid={!!errors.funded_at} required
            />
            {errors.funded_at && <p className="mt-1 text-xs text-status-hot">{errors.funded_at}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-term">Term (months)</label>
            <input
              id="fd-term" className={inputCls} value={form.term_months}
              onChange={set("term_months")} placeholder="10" inputMode="numeric"
              aria-invalid={!!errors.term_months}
            />
            {errors.term_months
              ? <p className="mt-1 text-xs text-status-hot">{errors.term_months}</p>
              : <p className="mt-1 text-[11px] text-fg-muted">Sets the renewal date.</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-points">Points (%)</label>
            <input
              id="fd-points" className={inputCls} value={form.points_pct}
              onChange={set("points_pct")} placeholder="11" inputMode="decimal"
              aria-invalid={!!errors.points_pct}
            />
            {errors.points_pct
              ? <p className="mt-1 text-xs text-status-hot">{errors.points_pct}</p>
              : <p className="mt-1 text-[11px] text-fg-muted">Sets the estimated commission.</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-factor">Factor rate</label>
            <input
              id="fd-factor" className={inputCls} value={form.factor_rate}
              onChange={set("factor_rate")} placeholder="1.35" inputMode="decimal"
              aria-invalid={!!errors.factor_rate}
            />
            {errors.factor_rate && <p className="mt-1 text-xs text-status-hot">{errors.factor_rate}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-contact">Contact name</label>
            <input
              id="fd-contact" className={inputCls} value={form.contact_name}
              onChange={set("contact_name")} placeholder="Ray Remington"
            />
          </div>

          <div>
            {/* Internal only. The renewal row reads this to avoid showing
                "No lender assigned"; it is never rendered on a merchant-facing
                surface. [[feedback_never_mention_lenders]] */}
            <label className={labelCls} htmlFor="fd-lender">Funder</label>
            <input
              id="fd-lender" className={inputCls} value={form.lender_name}
              onChange={set("lender_name")} placeholder="Who funded it"
            />
          </div>

          <div className="md:col-span-2">
            <label className={labelCls} htmlFor="fd-notes">Notes</label>
            <textarea
              id="fd-notes" className={inputCls} rows={2} value={form.notes}
              onChange={set("notes")} placeholder="Anything worth remembering at renewal time"
            />
          </div>
        </div>

        {/* The derived fields, shown before saving so they are visible rather
            than magic. Computed with the same functions the server uses. */}
        {(previewRenewal || previewCommission !== null) && (
          <div className="rounded-lg border border-border bg-bg-subtle px-3 py-2.5 text-xs text-fg-muted">
            <span className="font-bold uppercase tracking-[0.12em] text-[10px]">Will be calculated</span>
            <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1">
              <span>
                Renewal date:{" "}
                <span className="text-fg font-medium">{previewRenewal ?? "needs a funded date + term"}</span>
                {previewRenewal && <span className="ml-1">(halfway through the term)</span>}
              </span>
              <span>
                Est. commission:{" "}
                <span className="text-fg font-medium">
                  {previewCommission === null ? "needs an amount + points" : fmtUsd(previewCommission)}
                </span>
              </span>
            </div>
          </div>
        )}

        {formError && (
          <p className="text-sm text-status-hot" role="alert">{formError}</p>
        )}
        {saved && (
          <p className="flex items-center gap-1.5 text-sm text-status-warm" role="status">
            <Check size={14} /> Recorded {saved}. It will appear in the list below.
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit" disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? "Saving…" : confirmDuplicate ? "Record it anyway" : "Record funded deal"}
          </button>
          <span className="text-[11px] text-fg-muted">* required</span>
        </div>
      </form>
    </Card>
  );
}
