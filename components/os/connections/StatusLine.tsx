/**
 * StatusLine — a connector's status as a dot and one line of text.
 *
 * The dot is never the only signal (the label always says it in words), and
 * only a proven connection is green. "Set up" is neutral, a failed lookup is a
 * hollow amber ring rather than an empty grey one, so "we could not check" can
 * never be mistaken for "not connected".
 */

import type { ConnectorStatus } from "@/lib/os/connectors";

const DOT: Record<ConnectorStatus["kind"], string> = {
  connected: "bg-status-engaged",
  configured: "bg-fg-muted",
  attention: "bg-status-warm",
  unknown: "border border-status-warm",
  not_connected: "border border-fg-dim",
  coming_soon: "",
};

const TEXT: Record<ConnectorStatus["kind"], string> = {
  connected: "text-fg",
  configured: "text-fg-muted",
  attention: "text-status-warm",
  unknown: "text-fg-muted",
  not_connected: "text-fg-muted",
  coming_soon: "text-fg-dim",
};

export function StatusLine({ status, className = "" }: { status: ConnectorStatus; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 text-[12px] leading-4 ${TEXT[status.kind]} ${className}`}>
      {status.kind !== "coming_soon" && (
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status.kind]}`} />
      )}
      <span className="truncate">{status.label}</span>
    </span>
  );
}
