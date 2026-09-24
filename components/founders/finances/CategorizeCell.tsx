"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const groups = ["income", "expense", "transfer"] as const;
  return (
    <div className="min-w-[180px]">
      <select
        className="w-full rounded-md border border-bg-border bg-bg-deep px-2 py-1 text-xs text-fg focus:outline-none"
        value={current || ""}
        disabled={busy}
        onChange={async (e) => {
          const categoryId = e.target.value;
          if (!categoryId) return;
          setBusy(true);
          setErr(null);
          const r = await postFinanceAction({ action: status === "draft" ? "txn.approve" : "txn.categorize", txn_id: txnId, category_id: categoryId });
          setBusy(false);
          if (!r.ok) setErr(r.message || "Failed");
          else router.refresh();
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
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await postFinanceAction({ action: "txn.approve", txn_id: txnId });
            setBusy(false);
            if (!r.ok) setErr(r.message || "Failed");
            else router.refresh();
          }}
        >
          Approve suggestion
        </button>
      )}
      {err && <p className="mt-1 text-[11px] text-status-hot">{err}</p>}
    </div>
  );
}
