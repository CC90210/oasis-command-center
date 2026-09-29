/**
 * ChatAppCard — one chat app on Settings › Chat apps: its real logo, an honest
 * status, what it does for the team, and (for what exists today) the live
 * controls underneath.
 *
 * Server component. The logo and the words come from the Connections catalog
 * (lib/os/connectors.ts), so Chat apps and Connections can never describe the
 * same app two different ways.
 */

import type { ReactNode } from "react";
import { ConnectorIcon } from "@/components/os/connections/ConnectorIcon";
import { StatusLine } from "@/components/os/connections/StatusLine";
import type { ConnectorDef, ConnectorStatus } from "@/lib/os/connectors";

export function ChatAppCard({
  def,
  status,
  children,
}: {
  def: ConnectorDef;
  status: ConnectorStatus | null;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-bg-panel">
      <header className="flex items-start gap-3 px-4 py-4">
        <ConnectorIcon def={def} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-fg">{def.name}</h2>
            {status && <StatusLine status={status} />}
          </div>
          <ul className="mt-1.5 space-y-1 text-[13px] leading-5 text-fg-muted">
            {def.does.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      </header>
      {children && <div className="space-y-3 border-t border-hairline p-4">{children}</div>}
    </section>
  );
}
