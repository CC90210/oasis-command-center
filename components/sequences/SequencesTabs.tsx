"use client";

/**
 * SequencesTabs — top-level switch on /sequences between the management list
 * (toggle/create/delete) and the full template inventory ("show me exactly
 * what every campaign sends"). Templates first: during a re-templating hold
 * the reading surface is the primary one.
 */

import { useState } from "react";
import { LayoutList, FileText } from "lucide-react";
import { SequencesListClient } from "./SequencesListClient";
import { SequenceTemplatesView, type TemplatesViewRow } from "./SequenceTemplatesView";
import type { DripStep } from "@/lib/drips/types";

type Row = TemplatesViewRow & {
  trigger_event: string;
  one_per_lead: boolean;
  steps: DripStep[];
};

export function SequencesTabs({ rows }: { rows: Row[] }) {
  const [tab, setTab] = useState<"templates" | "manage">("templates");

  return (
    <div className="space-y-4">
      <div className="flex w-fit overflow-hidden rounded-lg border border-bg-border">
        <button
          type="button"
          onClick={() => setTab("templates")}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold transition-colors ${
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

      {tab === "templates" ? (
        <SequenceTemplatesView rows={rows} />
      ) : (
        <SequencesListClient initialRows={rows} />
      )}
    </div>
  );
}
