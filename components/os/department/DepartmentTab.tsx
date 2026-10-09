/**
 * DepartmentTab — the one frame every /team/<dept> page renders (design doc
 * §(b)): a header with the department's name and state, the CHANNEL as the
 * main column, and the OVERVIEW panel beside it (320px from `lg`, stacked under
 * the channel below that).
 *
 *   ┌ Sales                                         ● Working ┐
 *   ├──────────────────────────────────┬──────────────────────┤
 *   │ channel (AgentChat)               │ Needs you · Numbers  │
 *   │                                   │ Routines · Connections│
 *   │                                   │ Suggested asks        │
 *   └──────────────────────────────────┴──────────────────────┘
 *
 * Server component. The page reads and scopes everything; this lays it out.
 * The ComposerProvider wraps both columns so a Suggested ask on the right
 * fills the composer on the left.
 */

import { PageFrame } from "@/components/os/PageFrame";
import type { OsDepartment } from "@/lib/os/departments";
import type { ChannelState } from "./channel";
import { ComposerProvider } from "./ComposerContext";
import { DepartmentChannel } from "./DepartmentChannel";
import { OverviewPanel, type OverviewPanelProps } from "./OverviewPanel";
import { headerStatus, type DepartmentStatus } from "./StatusPill";
import { LiveStatusPill } from "./LiveStatusPill";

export type DepartmentTabProps = {
  dept: OsDepartment;
  purpose: string;
  status: DepartmentStatus;
  channel: ChannelState;
  /** A draft handed over by `?q=` (Today's Ask composer). Prefilled, never sent. */
  prefill: string | null;
  overview: OverviewPanelProps;
};

export function DepartmentTab({ dept, purpose, status, channel, prefill, overview }: DepartmentTabProps) {
  const ready = channel.kind === "ready";
  // The header also answers "did the last turn work?": a connected key the
  // provider refused reads Not working, in the words the channel used; an AI
  // account that could not be checked reads Couldn't check.
  const header = headerStatus(status, channel);
  return (
    <PageFrame
      title={dept.label}
      subtitle={purpose}
      // Redrawn by the channel's own turns (LiveStatusPill), so a reply that
      // arrives clears an old failure without a reload.
      actions={<LiveStatusPill department={dept.key} status={status} channelReady={ready} initial={header} />}
    >
      {/* Keyed by department: moving from Sales to Marketing is the same page
          component with new params, and without a key AgentChat would carry
          Sales' conversation — and its history — into Marketing's agent. A new
          `?q=` from Today is a new thread, so it is part of the key too. */}
      <ComposerProvider
        key={`${dept.key}|${prefill ?? ""}`}
        initialText={ready ? prefill : null}
        channelReady={ready}
      >
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <DepartmentChannel label={dept.label} state={channel} />
          <OverviewPanel {...overview} />
        </div>
      </ComposerProvider>
    </PageFrame>
  );
}
