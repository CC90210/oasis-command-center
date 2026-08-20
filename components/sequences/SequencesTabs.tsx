"use client";

/**
 * SequencesTabs — top-level switch on /sequences between the management list
 * (toggle/create/delete) and the full template inventory ("show me exactly
 * what every campaign sends"). Templates first: during a re-templating hold
 * the reading surface is the primary one.
 */

import { useState } from "react";
import { InterchangeLockProvider } from "./interchange-lock";
import { LayoutList, FileText, Activity, BarChart3 } from "lucide-react";
import { SequencesListClient } from "./SequencesListClient";
import { SequenceTemplatesView, type TemplatesViewRow } from "./SequenceTemplatesView";
import { DripActivityView, type ActivityRow, type ActivitySummary } from "./DripActivityView";
import { SequenceVolumeView, type VolumeRow } from "./SequenceVolumeView";
import type { ChannelLimits } from "@/lib/drips/channel-limits-core";
import type { ScoreboardResult } from "@/lib/drips/scoreboard-core";

/** Everything the Volume tab needs, resolved server-side. `error` is carried
 *  explicitly so a failed read renders as UNKNOWN rather than as an empty
 *  chart — the most reassuring picture available and, when the read broke, the
 *  least true one. */
export type VolumeTabData = {
  rows: VolumeRow[];
  days: number;
  timeZone: string;
  error: string | null;
  truncated: boolean;
  /** The SAME shape for texts. Carried separately rather than merged into
   *  `rows` because a sequence can send on both channels and a single number
   *  would hide which one moved — and the two have different ceilings. */
  sms: { rows: VolumeRow[]; error: string | null; truncated: boolean };
  /** The per-channel ceilings, resolved server-side so the editor opens on
   *  what the ENGINE is using rather than on the defaults. */
  limits: ChannelLimits;
};
import type { DripStep } from "@/lib/drips/types";
import type { PoolTemplate } from "@/lib/drips/template-pool";

type Row = TemplatesViewRow & {
  trigger_event: string;
  one_per_lead: boolean;
  steps: DripStep[];
};

export function SequencesTabs({
  rows,
  activity,
  activitySummary,
  activityError,
  summaryError,
  scoreboard,
  volume,
  pool,
}: {
  rows: Row[];
  activity: ActivityRow[];
  activitySummary: ActivitySummary;
  activityError?: string | null;
  summaryError?: string | null;
  /** Per-sequence rollup for the Activity tab. Its own read and its own error,
   *  so a short activity table cannot mark these counts unknown or vice versa. */
  scoreboard?: ScoreboardResult | null;
  volume: VolumeTabData;
  pool: PoolTemplate[];
}) {
  // Activity first. The first question an operator has is "what went out",
  // not "how is it configured" — and for four days in August the honest answer
  // was "nothing", which no surface was able to say.
  const [tab, setTab] = useState<"activity" | "volume" | "templates" | "manage">("activity");

  return (
    // ABOVE the tab switch. Inside the Templates view it unmounts the moment an
    // operator changes tab, and remounts unlocked while the same stale rows are
    // still in memory — so leaving and returning after a save would re-enable
    // the swap that reverts it. resetKey={rows} is a NEW object on every server
    // re-render, which is the real signal that fresh data landed.
    <InterchangeLockProvider resetKey={rows}>
    <div className="space-y-4">
      <div className="flex w-fit overflow-hidden rounded-lg border border-bg-border">
        <button
          type="button"
          onClick={() => setTab("activity")}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold transition-colors ${
            tab === "activity" ? "bg-accent/15 text-accent" : "bg-bg-elev text-fg-muted hover:text-fg"
          }`}
        >
          <Activity className="h-3.5 w-3.5" />
          Activity
        </button>
        <button
          type="button"
          onClick={() => setTab("volume")}
          className={`inline-flex items-center gap-1.5 border-l border-bg-border px-4 py-2 text-xs font-bold transition-colors ${
            tab === "volume" ? "bg-accent/15 text-accent" : "bg-bg-elev text-fg-muted hover:text-fg"
          }`}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Volume
        </button>
        <button
          type="button"
          onClick={() => setTab("templates")}
          className={`inline-flex items-center gap-1.5 border-l border-bg-border px-4 py-2 text-xs font-bold transition-colors ${
            tab === "templates" ? "bg-accent/15 text-accent" : "bg-bg-elev text-fg-muted hover:text-fg"
          }`}
        >
          <FileText className="h-3.5 w-3.5" />
          Templates
        </button>
        <button
          type="button"
          onClick={() => setTab("manage")}
          className={`inline-flex items-center gap-1.5 border-l border-bg-border px-4 py-2 text-xs font-bold transition-colors ${
            tab === "manage" ? "bg-accent/15 text-accent" : "bg-bg-elev text-fg-muted hover:text-fg"
          }`}
        >
          <LayoutList className="h-3.5 w-3.5" />
          Manage
        </button>
      </div>

      {tab === "activity" ? (
        <DripActivityView
          rows={activity}
          summary={activitySummary}
          readError={activityError ?? null}
          summaryError={summaryError ?? null}
          scoreboard={scoreboard ?? null}
        />
      ) : tab === "volume" ? (
        <SequenceVolumeView
          rows={volume.rows}
          days={volume.days}
          timeZone={volume.timeZone}
          readError={volume.error}
          truncated={volume.truncated}
          sms={volume.sms}
          limits={volume.limits}
        />
      ) : tab === "templates" ? (
        <SequenceTemplatesView rows={rows} pool={pool} />
      ) : (
        <SequencesListClient initialRows={rows} />
      )}
    </div>
    </InterchangeLockProvider>
  );
}
