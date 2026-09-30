/**
 * TeammateRow — one AI teammate on the AI Team roster: initial, name, what it
 * does, which departments it leads, and where it lives.
 *
 * WHERE IT LIVES IS STATED, NOT IMPLIED. Web is the department channel (or the
 * custom teammate's chat) and says whether it can answer. Slack and Telegram
 * are v1 surfaces in the plan (decision 3) that do not exist yet, so they read
 * "Phase 2" rather than a toggle that does nothing.
 *
 * Server component. Dense rows on a hairline list, the same density as the
 * rail and the channel; no card grid.
 */

import Link from "next/link";
import { Check } from "lucide-react";
import type { TeammateHome } from "./roster";

/**
 * ready          answering (a key on file, and no failed last turn)
 * not_working    a key on file, but its channel's last turn failed; the
 *                department header says "Not working" for the same reason
 * not_connected  no AI account, or no agent settings, for this workspace
 * not_set_up     no teammate behind this department yet
 * unknown        a read behind the answer failed, so it is not known
 */
export type WebState = "ready" | "not_working" | "not_connected" | "not_set_up" | "unknown";

const WEB_LABEL: Record<WebState, string> = {
  ready: "Web",
  not_working: "Web · not working",
  not_connected: "Web · not connected",
  not_set_up: "Web · not set up",
  unknown: "Web · couldn’t check",
};

function Initial({ name }: { name: string }) {
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-bg-raised text-sm font-semibold text-fg"
    >
      {letter}
    </span>
  );
}

export function Homes({ web }: { web: WebState }) {
  return (
    <ul aria-label="Where it lives" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-4">
      <li
        className={`inline-flex items-center gap-1 ${
          web === "ready" ? "text-fg-muted" : web === "not_working" ? "text-status-hot" : "text-fg-dim"
        }`}
      >
        {web === "ready" && <Check className="h-3.5 w-3.5 text-status-engaged" strokeWidth={2} aria-hidden />}
        {WEB_LABEL[web]}
      </li>
      <li className="text-fg-dim">Slack · Phase 2</li>
      <li className="text-fg-dim">Telegram · Phase 2</li>
    </ul>
  );
}

export function TeammateRow({
  name,
  summary,
  meta,
  departments,
  web,
  href,
  badge,
}: {
  name: string;
  summary: string;
  /** Category, or "Custom". Muted, beside the name. */
  meta?: string;
  departments?: readonly TeammateHome[];
  web: WebState;
  /** Where the name links: the teammate's channel or chat. */
  href?: string | null;
  /** A short state word on the right, e.g. "On" / "Off". */
  badge?: string;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Initial name={name} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {href ? (
            <Link href={href} prefetch={false} className="text-sm font-semibold text-fg hover:underline">
              {name}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-fg">{name}</span>
          )}
          {meta && <span className="text-xs text-fg-dim">{meta}</span>}
        </div>
        {summary && <p className="text-[13px] leading-5 text-fg-muted">{summary}</p>}
        {departments && departments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {departments.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                prefetch={false}
                className="inline-flex h-6 items-center rounded-md border border-hairline px-1.5 text-xs font-medium text-fg-muted transition-colors duration-150 hover:bg-active-hover hover:text-fg"
              >
                {d.label}
              </Link>
            ))}
          </div>
        )}
        <Homes web={web} />
      </div>
      {badge && (
        <span className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-[11px] font-medium leading-4 text-fg-muted">
          {badge}
        </span>
      )}
    </li>
  );
}
