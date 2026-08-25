"use client";

import { ClipboardCheck } from "lucide-react";

export type BuildBriefDraft = {
  businessGoal: string;
  targetAudience: string;
  mustHavePages: string;
  requiredFeatures: string;
  integrations: string;
  contentAndAssets: string;
  domainAndAccess: string;
  launchTiming: string;
  decisionProcess: string;
  transcriptNotes: string;
};

const EMPTY: BuildBriefDraft = {
  businessGoal: "",
  targetAudience: "",
  mustHavePages: "",
  requiredFeatures: "",
  integrations: "",
  contentAndAssets: "",
  domainAndAccess: "",
  launchTiming: "",
  decisionProcess: "",
  transcriptNotes: "",
};

const INPUT =
  "mt-1.5 w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg outline-none transition placeholder:text-fg-faint focus:border-accent/70 focus:ring-1 focus:ring-accent/30";

export function LeadBuildBriefForm({
  disabled,
  initial,
  onSubmit,
}: {
  disabled: boolean;
  initial?: Partial<BuildBriefDraft> | null;
  onSubmit: (brief: BuildBriefDraft) => void;
}) {
  const draft: BuildBriefDraft = { ...EMPTY, ...(initial || {}) };

  // Inputs live in the parent form through a keyed uncontrolled draft. The
  // native FormData boundary keeps this component light even with a long pasted
  // transcript and avoids re-rendering the whole lifecycle panel per keystroke.
  return (
    <form
      className="space-y-4 rounded-xl border border-accent/25 bg-accent/[0.035] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const brief = Object.fromEntries(
          Object.keys(EMPTY).map((field) => [field, String(data.get(field) || "").trim()]),
        ) as BuildBriefDraft;
        onSubmit(brief);
      }}
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <ClipboardCheck className="h-4 w-4" aria-hidden />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-fg">Closing-call build brief</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Capture the decisions while they are fresh. This exact brief follows the paid client into
            the builder queue; the client does not need to complete another long form.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <BriefField name="businessGoal" label="Business goal" defaultValue={draft.businessGoal} placeholder="What result must this site produce?" />
        <BriefField name="targetAudience" label="Ideal customer" defaultValue={draft.targetAudience} placeholder="Who needs to take action?" />
        <BriefField name="mustHavePages" label="Pages and content structure" defaultValue={draft.mustHavePages} placeholder="Home, services, locations, about, contact…" />
        <BriefField name="requiredFeatures" label="Required features" defaultValue={draft.requiredFeatures} placeholder="Booking, quote form, payments, portal, chat…" />
        <BriefField name="integrations" label="Integrations (optional)" defaultValue={draft.integrations} placeholder="CRM, calendar, analytics, payments…" required={false} />
        <BriefField name="contentAndAssets" label="Content and brand assets" defaultValue={draft.contentAndAssets} placeholder="Logo, photos, copy, colours—who supplies what?" />
        <BriefField name="domainAndAccess" label="Domain and account access" defaultValue={draft.domainAndAccess} placeholder="Registrar, hosting, delegated access, missing credentials…" />
        <BriefField name="launchTiming" label="Launch timing" defaultValue={draft.launchTiming} placeholder="Deadline, milestones, urgency, dependencies…" />
      </div>

      <BriefField
        name="decisionProcess"
        label="Decision, approvals, and constraints"
        defaultValue={draft.decisionProcess}
        placeholder="Who approves scope and launch? Note budget or legal constraints."
        rows={3}
      />
      <BriefField
        name="transcriptNotes"
        label="Transcript or call notes (optional)"
        defaultValue={draft.transcriptNotes}
        placeholder="Paste the closing-call transcript or the relevant excerpts. The structured fields above remain the builder's source of truth."
        required={false}
        rows={5}
        maxLength={20_000}
      />

      <button
        type="submit"
        disabled={disabled}
        className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-sm"
      >
        <ClipboardCheck className="h-4 w-4" aria-hidden />
        Complete audit and send brief to pricing
      </button>
    </form>
  );
}

function BriefField({
  name,
  label,
  defaultValue,
  placeholder,
  required = true,
  rows = 2,
  maxLength = 6_000,
}: {
  name: keyof BuildBriefDraft;
  label: string;
  defaultValue: string;
  placeholder: string;
  required?: boolean;
  rows?: number;
  maxLength?: number;
}) {
  return (
    <label className="block text-xs text-fg-muted">
      {label}{required ? " *" : ""}
      <textarea
        name={name}
        defaultValue={defaultValue}
        required={required}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        className={`${INPUT} resize-y`}
      />
    </label>
  );
}
