"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, PhoneCall } from "lucide-react";

type Props = {
  leadId: string;
  displayName: string;
  phone: string | null;
  onCallAccepted?: () => void;
};

type CallResponse = {
  ok?: boolean;
  dry_run?: boolean;
  error?: string;
  message?: string;
  tracking_warning?: string | null;
};

/**
 * The call trigger used inside the stage-specific Next step panel. It stays a
 * separate component because provider acceptance and the canonical touch are
 * one guarded operation, while the parent owns the follow-up outcome flow.
 */
export function LeadActionToolbar({ leadId, displayName, phone, onCallAccepted }: Props) {
  const router = useRouter();
  const [calling, setCalling] = useState(false);
  const [callNotice, setCallNotice] = useState<string | null>(null);
  const callable = Boolean(phone?.trim());

  async function callNow() {
    if (!callable || calling) return;
    setCalling(true);
    setCallNotice(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: `OASIS lead - ${displayName}` }),
      });
      const result = (await response.json().catch(() => ({}))) as CallResponse;
      if (!response.ok || !result.ok) {
        throw new Error(result.message || readableCallError(result.error || `call_${response.status}`));
      }
      if (result.dry_run) {
        setCallNotice(result.message || "Call routing was validated in dry-run mode; no call was placed.");
        return;
      }
      setCallNotice(
        result.tracking_warning
          ? `${result.message || "The call provider accepted the request."} The call was placed, but activity tracking needs an admin check.`
          : result.message || "The call provider accepted the request. Pick up your line to connect.",
      );
      window.dispatchEvent(new CustomEvent("oasis:lead-touch", { detail: { leadId } }));
      onCallAccepted?.();
      router.refresh();
    } catch (error) {
      setCallNotice(error instanceof Error ? error.message : "The call could not be started.");
    } finally {
      setCalling(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-3 rounded-xl border border-status-engaged/35 bg-status-engaged/5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-status-engaged" aria-hidden />
            <span className="text-sm font-semibold text-fg">Call {displayName}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            {callable
              ? `Your rep line rings first, then connects to ${phone}.`
              : "Add a valid phone number in Lead details before calling."}
          </p>
        </div>
        <button
          type="button"
          disabled={!callable || calling}
          onClick={() => void callNow()}
          className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 !px-4 !py-2 text-sm"
        >
          {calling ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {calling ? "Starting call…" : "Call now"}
        </button>
      </div>
      {callNotice ? (
        <div className="rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-xs text-fg-muted" role="status" aria-live="polite">
          {callNotice}
        </div>
      ) : null}
    </div>
  );
}

function readableCallError(code: string): string {
  const known: Record<string, string> = {
    no_phone: "This lead has no valid phone number.",
    missing_credentials: "Calling is not connected for this workspace.",
    no_agent_email: "Your account is not mapped to a calling line yet.",
    lead_not_assigned_to_agent: "This lead is assigned to another rep.",
    forbidden_role: "Your role cannot place calls.",
    kixie_call_failed: "The call provider rejected the request. Try again before logging an outcome.",
  };
  return known[code] || code.replaceAll("_", " ");
}
