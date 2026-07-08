"use client";

/**
 * AISuggestionRail — plan §6.4 #3: proactive next-action chips derived from
 * lead state (missing stips -> "Send stip reminder"; an offer on file ->
 * "Offer payoff discount") plus the summarize key-points. Click pre-fills
 * the composer via the existing SlashCommandTemplateMenu template
 * interpolation, so the operator still reviews/edits before sending — this
 * never sends anything itself.
 *
 * "Offer present" has no single canonical field in tenant_records (see
 * DealDetailsAccordion's doc comment on the same schema-reality gap for
 * missing_info) — this checks the same offer/approved-amount fields the
 * lender-intelligence + funder-offer surfaces use, falling back to a
 * stage-name heuristic. Best-effort by design; false negatives just mean
 * one fewer chip, never a wrong send.
 */
import { Sparkles, FileWarning, Percent, PhoneCall } from "lucide-react";
import { DEFAULT_SMS_TEMPLATES, interpolateTemplate } from "./SlashCommandTemplateMenu";
import type { KeyPoint } from "@/lib/ai-conversation-summarize";

export type SuggestionChip = { id: string; label: string; icon: "docs" | "offer" | "call"; text: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function hasOfferOnFile(record: Record<string, unknown>, application: { data: Record<string, unknown> } | null): boolean {
  const candidates = [
    record.offer_amount,
    record.approved_amount,
    application?.data?.offer_amount,
    application?.data?.approved_amount,
  ];
  if (candidates.some((v) => typeof v === "number" && v > 0)) return true;
  const stage = (str(record.stage) || str(record.status) || "").toLowerCase();
  return /offer|approved/.test(stage);
}

const FOLLOWUP_RE = /reschedul|call back|call me back|follow.?up/i;

export function deriveSuggestionChips(args: {
  missingStips: { key: string; label: string }[];
  record: Record<string, unknown>;
  application: { data: Record<string, unknown> } | null;
  keyPoints: KeyPoint[];
  templateVars: Record<string, string | undefined>;
}): SuggestionChip[] {
  const { missingStips, record, application, keyPoints, templateVars } = args;
  const chips: SuggestionChip[] = [];

  if (missingStips.length > 0) {
    const tpl = DEFAULT_SMS_TEMPLATES.find((t) => t.id === "docs");
    chips.push({
      id: "stip_reminder",
      label: "Send stip reminder",
      icon: "docs",
      text: tpl ? interpolateTemplate(tpl.body, templateVars) : "",
    });
  }

  if (hasOfferOnFile(record, application)) {
    const tpl = DEFAULT_SMS_TEMPLATES.find((t) => t.id === "offer_ready");
    chips.push({
      id: "offer_payoff",
      label: "Offer payoff discount",
      icon: "offer",
      text: tpl ? interpolateTemplate(tpl.body, templateVars) : "",
    });
  }

  if (keyPoints.some((kp) => FOLLOWUP_RE.test(kp.text))) {
    const tpl = DEFAULT_SMS_TEMPLATES.find((t) => t.id === "missed_call");
    chips.push({
      id: "follow_up",
      label: "Follow up",
      icon: "call",
      text: tpl ? interpolateTemplate(tpl.body, templateVars) : "",
    });
  }

  return chips;
}

const ICONS = { docs: FileWarning, offer: Percent, call: PhoneCall };

export function AISuggestionRail({
  chips,
  onAction,
}: {
  chips: SuggestionChip[];
  onAction: (text: string) => void;
}) {
  if (chips.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-0.5">
        <Sparkles className="h-3 w-3 text-violet-400/50 shrink-0" />
        <span className="text-[10.5px] text-fg-dim italic">No suggested actions right now.</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 px-0.5 flex-wrap">
      <Sparkles className="h-3 w-3 text-violet-400/50 shrink-0" />
      {chips.map((chip) => {
        const Icon = ICONS[chip.icon];
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => onAction(chip.text)}
            disabled={!chip.text}
            className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-1 rounded-md border border-violet-500/25 bg-violet-500/[0.06] text-violet-300 hover:bg-violet-500/15 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Icon className="h-3 w-3" />
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
