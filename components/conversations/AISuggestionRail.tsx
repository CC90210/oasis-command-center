"use client";

/**
 * AISuggestionRail — plan §6.4 #3: proactive next-action chips derived from
 * lead state (missing stips -> "Send stip reminder"; an offer on file ->
 * "Offer payoff discount"; the pipeline stage -> the right next-stage nudge)
 * plus the summarize key-points. Message chips pre-fill the composer via the
 * existing SlashCommandTemplateMenu template interpolation, so the operator
 * still reviews/edits before sending — this never sends anything itself. The
 * "Request a call" chip opens the in-house call scheduler (onRequestCall).
 *
 * "Offer present" has no single canonical field in tenant_records (see
 * DealDetailsAccordion's doc comment on the same schema-reality gap for
 * missing_info) — this checks the same offer/approved-amount fields the
 * lender-intelligence + funder-offer surfaces use, falling back to a
 * stage-name heuristic. Best-effort by design; false negatives just mean
 * one fewer chip, never a wrong send.
 *
 * Stage copy is compliant by construction: no lender names, no rate/term
 * promises, no em dashes; the send gate appends the opt-out footer + enforces
 * suppression, so these bodies stay short and human.
 */
import { Sparkles, FileWarning, Percent, PhoneCall, RefreshCw, ClipboardList, CalendarClock } from "lucide-react";
import { DEFAULT_SMS_TEMPLATES, interpolateTemplate } from "./SlashCommandTemplateMenu";
import type { KeyPoint } from "@/lib/ai-conversation-summarize";

export type SuggestionChip = {
  id: string;
  label: string;
  icon: "docs" | "offer" | "call" | "reengage" | "finish" | "schedule";
  /** "compose" (default) pre-fills the composer with `text`; "call" opens the scheduler. */
  action?: "compose" | "call";
  text: string;
};

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

// Stage buckets → the single most useful next-step message for that stage.
// Keys match LEAD_PIPELINE_STAGES (lib/sunbiz-stage-meta.ts).
const FINISH_APP_STAGES = new Set(["intent_inquiry_submitted", "sent_application", "viewed_application"]);
const BANK_STATEMENT_STAGES = new Set(["signed_application", "submitted_application", "missing_info", "uw_sheet"]);
const REENGAGE_STAGES = new Set(["follow_up", "ghost", "dead_file"]);

function stageChip(stage: string, vars: Record<string, string | undefined>): SuggestionChip | null {
  if (FINISH_APP_STAGES.has(stage)) {
    return {
      id: "finish_application",
      label: "Nudge to finish app",
      icon: "finish",
      text: interpolateTemplate(
        "Hi {{first_name}}, just checking in on {{merchant_company}}'s application. Want to finish it up so we can get you reviewed? Only takes a couple minutes, reply here if you have any questions.",
        vars,
      ),
    };
  }
  if (BANK_STATEMENT_STAGES.has(stage)) {
    const tpl = DEFAULT_SMS_TEMPLATES.find((t) => t.id === "docs");
    return {
      id: "request_statements",
      label: "Ask for bank statements",
      icon: "docs",
      text: tpl ? interpolateTemplate(tpl.body, vars) : "",
    };
  }
  if (REENGAGE_STAGES.has(stage)) {
    return {
      id: "reengage",
      label: "Get back in contact",
      icon: "reengage",
      text: interpolateTemplate(
        "Hi {{first_name}}, are you still looking for extra capital for {{merchant_company}}? Happy to pick back up whenever the timing is right, just let me know.",
        vars,
      ),
    };
  }
  return null;
}

export function deriveSuggestionChips(args: {
  missingStips: { key: string; label: string }[];
  record: Record<string, unknown>;
  application: { data: Record<string, unknown> } | null;
  keyPoints: KeyPoint[];
  templateVars: Record<string, string | undefined>;
}): SuggestionChip[] {
  const { missingStips, record, application, keyPoints, templateVars } = args;
  const chips: SuggestionChip[] = [];
  const seen = new Set<string>();
  const push = (chip: SuggestionChip | null) => {
    if (chip && chip.id === "request_statements" && seen.has("stip_reminder")) return; // dedupe with stip chip
    if (chip && !seen.has(chip.id)) {
      chips.push(chip);
      seen.add(chip.id);
    }
  };

  if (missingStips.length > 0) {
    const tpl = DEFAULT_SMS_TEMPLATES.find((t) => t.id === "docs");
    push({
      id: "stip_reminder",
      label: "Send stip reminder",
      icon: "docs",
      text: tpl ? interpolateTemplate(tpl.body, templateVars) : "",
    });
  }

  // Stage-aware next-step chip (finish app / bank statements / re-engage).
  const stage = (str(record.stage) || str(record.status) || "").toLowerCase();
  push(stageChip(stage, templateVars));

  if (hasOfferOnFile(record, application)) {
    const tpl = DEFAULT_SMS_TEMPLATES.find((t) => t.id === "offer_ready");
    push({
      id: "offer_payoff",
      label: "Offer payoff discount",
      icon: "offer",
      text: tpl ? interpolateTemplate(tpl.body, templateVars) : "",
    });
  }

  if (keyPoints.some((kp) => FOLLOWUP_RE.test(kp.text))) {
    const tpl = DEFAULT_SMS_TEMPLATES.find((t) => t.id === "missed_call");
    push({
      id: "follow_up",
      label: "Follow up",
      icon: "call",
      text: tpl ? interpolateTemplate(tpl.body, templateVars) : "",
    });
  }

  // Always offer to book a call (opens the in-house scheduler, not a send).
  push({ id: "request_call", label: "Request a call", icon: "schedule", action: "call", text: "" });

  return chips;
}

const ICONS = {
  docs: FileWarning,
  offer: Percent,
  call: PhoneCall,
  reengage: RefreshCw,
  finish: ClipboardList,
  schedule: CalendarClock,
};

export function AISuggestionRail({
  chips,
  onAction,
  onRequestCall,
}: {
  chips: SuggestionChip[];
  onAction: (text: string) => void;
  onRequestCall?: () => void;
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
        const isCall = chip.action === "call";
        const disabled = isCall ? !onRequestCall : !chip.text;
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => (isCall ? onRequestCall?.() : onAction(chip.text))}
            disabled={disabled}
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
