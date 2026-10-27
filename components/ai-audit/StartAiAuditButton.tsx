"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { describeError } from "@/components/ai-audit/workspace/api";

/** Opens the lead's engagement (or the one already open) and goes to it. */
export function StartAiAuditButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "open", lead_id: leadId }) });
      const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok?: boolean; engagement_id?: string; error?: string };
      if (json.ok && json.engagement_id) {
        router.push(`/ai-audits/${json.engagement_id}`);
        return;
      }
      setError(`Could not start the audit. ${describeError({ ok: false, error: json.error })}`);
    } catch {
      setError(`Could not start the audit. ${describeError({ ok: false, error: "network_error" })}`);
    }
    setBusy(false);
  }
  return (
    <div className="flex items-center gap-2">
      {error ? <span className="text-[13px] text-status-hot">{error}</span> : null}
      <button type="button" className="btn-primary" disabled={busy} onClick={start}>
        Start AI audit
      </button>
    </div>
  );
}
