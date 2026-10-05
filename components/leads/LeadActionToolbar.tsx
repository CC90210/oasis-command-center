"use client";

import { PhoneCall } from "lucide-react";

type Props = {
  displayName: string;
  phone: string | null;
  onDialerOpened?: () => void;
};

/**
 * Opens the rep's own phone/computer dialer from the stage-specific Next step
 * panel. The parent owns the follow-up outcome flow and only persists a touch
 * after the rep records what happened.
 */
export function LeadActionToolbar({ displayName, phone, onDialerOpened }: Props) {
  const dialTarget = phone?.trim().replace(/[^\d+]/g, "") || "";
  const callable = Boolean(dialTarget);

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
              ? `Opens your phone or computer dialer for ${phone}. Record the outcome when you return.`
              : "Add a valid phone number in Lead details before calling."}
          </p>
        </div>
        {callable ? (
          <a
            href={`tel:${dialTarget}`}
            onClick={onDialerOpened}
            className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 !px-4 !py-2 text-sm"
          >
            Open dialer
          </a>
        ) : (
          <span
            aria-disabled="true"
            className="btn-primary inline-flex shrink-0 cursor-not-allowed items-center justify-center gap-2 !px-4 !py-2 text-sm opacity-50"
          >
            Open dialer
          </span>
        )}
      </div>
    </div>
  );
}
