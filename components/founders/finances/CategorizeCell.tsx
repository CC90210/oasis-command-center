"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { postFinanceAction } from "./ActionForm";

/**
 * Pick a category for a register row; choosing one posts it to the ledger
 * (or re-posts it if it was already categorised). Drafts from Atlas are
 * approved the same way.
 */
export function CategorizeCell({
  txnId,
  current,
  categories,
  status,
}: {
  txnId: string;
  current: string | null;
  categories: Array<{ id: string; name: string; kind: string }>;
  status: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [transitionPending, startTransition] = useTransition();
  const [selectedCategoryId, setSelectedCategoryId] = useState(current || "");
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pending = submitting || transitionPending;
  const groups = ["income", "expense", "transfer"] as const;

  useEffect(() => {
    if (!pending) setSelectedCategoryId(current || "");
  }, [current, pending]);

  async function postCategory(categoryId: string, includeCategory: boolean) {
    if (!categoryId || pending || inFlight.current) return;
    const previousCategoryId = selectedCategoryId;
    setSelectedCategoryId(categoryId);
    setSubmitting(true);
    setErr(null);
    inFlight.current = true;
    try {
      const r = await postFinanceAction({
        action: status === "draft" ? "txn.approve" : "txn.categorize",
        txn_id: txnId,
        ...(includeCategory ? { category_id: categoryId } : {}),
      });
      if (!r.ok) {
        setSelectedCategoryId(previousCategoryId);
        setErr(r.message || "Failed");
        return;
      }
      startTransition(() => router.refresh());
    } catch (error) {
      setSelectedCategoryId(previousCategoryId);
      setErr(error instanceof Error ? error.message : "Network error.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="min-w-[180px]" aria-busy={pending}>
      <select
        className="w-full rounded-md border border-bg-border bg-bg-deep px-2 py-1 text-xs text-fg focus:outline-none"
        value={selectedCategoryId}
        disabled={pending}
        aria-describedby={pending ? `category-pending-${txnId}` : undefined}
        onChange={(e) => {
          const categoryId = e.target.value;
          if (!categoryId) return;
          void postCategory(categoryId, true);
        }}
      >
        <option value="">{status === "draft" ? "Approve as…" : "Categorise…"}</option>
        {groups.map((g) => (
          <optgroup key={g} label={g === "transfer" ? "Transfer" : g === "income" ? "Income" : "Expense"}>
            {categories
              .filter((c) => c.kind === g)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {status === "draft" && current && (
        <button
          type="button"
          className="mt-1 text-[11px] text-[#1FE3F0] hover:underline"
          disabled={pending}
          onClick={() => void postCategory(selectedCategoryId, false)}
        >
          Approve suggestion
        </button>
      )}
      {pending && (
        <p id={`category-pending-${txnId}`} role="status" aria-live="polite" className="mt-1 text-[11px] text-fg-muted">
          Posting — not in ledger or reports yet
        </p>
      )}
      {err && <p role="alert" className="mt-1 text-[11px] text-status-hot">{err}</p>}
    </div>
  );
}
