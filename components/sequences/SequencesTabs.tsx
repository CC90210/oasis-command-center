"use client";

/**
 * SequencesTabs — top-level switch on /sequences between the management list
 * (toggle/create/delete) and the full template inventory ("show me exactly
 * what every campaign sends"). Templates first: during a re-templating hold
 * the reading surface is the primary one.
 */

import { useState } from "react";
import { LayoutList, FileText, Activity } from "lucide-react";
import { SequencesListClient } from "./SequencesListClient";
import { SequenceTemplatesView, type TemplatesViewRow } from "./SequenceTemplatesView";
import { DripActivityView, type ActivityRow, type ActivitySummary } from "./DripActivityView";
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
  pool,
}: {
  rows: Row[];
  activity: ActivityRow[];
  activitySummary: ActivitySummary;
  activityError?: string | null;
  summaryError?: string | null;
  pool: PoolTemplate[];
}) {
  // Activity first. The first question an operator has is "what went out",
  // not "how is it configured" — and for four days in August the honest answer
  // was "nothing", which no surface was able to say.
  const [tab, setTab] = useState<"activity" | "templates" | "manage">("activity");

  return (
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
        />
      ) : tab === "templates" ? (
        <SequenceTemplatesView rows={rows} pool={pool} />
      ) : (
        <SequencesListClient initialRows={rows} />
      )}
    </div>
  );
}
