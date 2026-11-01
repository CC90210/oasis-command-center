"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const ERRORS: Record<string, string> = {
  not_configured: "Save a Meta Ads token and ad account in this workspace's connection first.",
  no_linked_ads: "No saved creatives have a Meta ad ID. Link the published ads to their creative records before importing.",
  mapping_conflict: "Multiple or conflicting ad IDs are saved. Correct the creative links before importing.",
  report_context_conflict: "The saved report uses a different or unknown account, currency, timezone or conversion definition. Check these details before importing.",
  mapping_changed: "A creative changed during the import. Retry to use its latest link.",
  provider_rejected: "Meta refused this report. Check the saved token's ads_read access and retry.",
  provider_unavailable: "Meta did not answer. Saved results remain unchanged; retry later.",
  invalid_report: "Meta returned an incomplete or inconsistent report. Saved results remain unchanged.",
  report_too_large: "This report exceeds the manual import limit. Saved results remain unchanged.",
};

export function ImportMetaDelivery() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function run() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/marketing/ads/import", { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.ok) setMessage(ERRORS[result.error] ?? "The import could not finish. Saved results remain unchanged.");
      else {
        setMessage(result.imported ? `Imported ${result.imported} daily ad reports (${result.timezone}). ${result.unlinkedAssets} creatives have no ad ID; ${result.unmatchedRows} reports had no matching creative.` : "Meta returned no matching delivery reports. Existing results are unchanged.");
        router.refresh();
      }
    } catch { setMessage("The import could not finish. Refresh the page to check the saved results before retrying."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2"><button type="button" className="btn-secondary" disabled={busy} onClick={run}>{busy ? "Importing delivery…" : "Import Meta delivery"}</button>
    {message && <p role="status" className="text-[13px] text-fg-muted">{message}</p>}</div>;
}
