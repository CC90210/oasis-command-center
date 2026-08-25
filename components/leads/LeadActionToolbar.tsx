"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, LoaderCircle, PhoneCall } from "lucide-react";

type Props = {
  leadId: string;
  displayName: string;
  phone: string | null;
  currentStage: string;
};

type CallResponse = {
  ok?: boolean;
  dry_run?: boolean;
  error?: string;
  message?: string;
  tracking_warning?: string | null;
};

/**
 * The two immediate rep actions on an OASIS lead file.
 *
 * Calling uses the authenticated server route so the provider request, acting
 * rep, timeline row, and canonical Last Touch stay tied to the lead. Calendar
 * booking remains inside the lifecycle control because its explicit save
 * confirmation and qualification facts must land in one Turso transition.
 */
export function LeadActionToolbar({ leadId, displayName, phone, currentStage }: Props) {
  const router = useRouter();
  const [calling, setCalling] = useState(false);
  const [callNotice, setCallNotice] = useState<string | null>(null);
  const scheduleAvailable = ["assigned", "attempting_contact", "connected", "qualified"].includes(
    currentStage,
  );
  const readyToBook = currentStage === "qualified";
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
      router.refresh();
    } catch (error) {
      setCallNotice(error instanceof Error ? error.message : "The call could not be started.");
    } finally {
      setCalling(false);
    }
  }

  return (
    <section className="space-y-2" aria-label="Lead actions">
      <div className={`grid gap-3 ${scheduleAvailable ? "md:grid-cols-2" : ""}`}>
        <button
          type="button"
          disabled={!callable || calling}
          onClick={() => void callNow()}
          className="group flex items-center justify-between gap-4 rounded-xl border border-status-engaged/40 bg-status-engaged/5 px-5 py-4 text-left transition-colors hover:bg-status-engaged/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div>
            <div className="flex items-center gap-2">
              {calling ? (
                <LoaderCircle className="h-4 w-4 animate-spin text-status-engaged" aria-hidden />
              ) : (
                <PhoneCall className="h-4 w-4 text-status-engaged" aria-hidden />
              )}
              <span className="text-sm font-bold text-fg">{calling ? "Starting call..." : "Call now"}</span>
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              {callable
                ? "Rings your rep line first, then bridges you to the lead. A live provider acceptance is tracked as a touch."
                : "Add a valid phone number before calling this lead."}
            </p>
          </div>
          <span className="text-xs font-semibold text-status-engaged">{phone || "No phone"}</span>
        </button>

        {scheduleAvailable ? (
          <a
            href="#founder-audit-handoff"
            className="group flex items-center justify-between gap-4 rounded-xl border border-accent/40 bg-accent/5 px-5 py-4 transition-colors hover:bg-accent/10"
          >
            <div>
              <div className="flex items-center gap-2">
                <CalendarPlus className="h-4 w-4 text-accent" aria-hidden />
                <span className="text-sm font-bold text-fg">Schedule founder audit</span>
              </div>
              <p className="mt-1 text-xs text-fg-muted">
                {readyToBook
                  ? "Choose the exact time and host, open the prefilled 15-minute event, then confirm it was saved."
                  : "You can schedule now, but all qualification gates and a handoff note are required before the event can move this lead."}
              </p>
            </div>
            <span className="text-xs font-semibold text-accent transition-transform group-hover:translate-x-0.5">
              {readyToBook ? "Book audit" : "Qualify + book"}
            </span>
          </a>
        ) : null}
      </div>
      {callNotice ? (
        <div className="rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-xs text-fg-muted" role="status" aria-live="polite">
          {callNotice}
        </div>
      ) : null}
    </section>
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
