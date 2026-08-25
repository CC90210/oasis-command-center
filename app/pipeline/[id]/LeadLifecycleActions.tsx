"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, Clock3 } from "lucide-react";
import {
  LeadBuildBriefForm,
  type BuildBriefDraft,
} from "@/components/leads/LeadBuildBriefForm";
import { OASIS_LEAD_STAGES, findOasisStage } from "@/lib/oasis-stage-meta";
import {
  AUTOMATION_ADD_ONS,
  WEBSITE_PACKAGES,
  type WebsitePackageId,
} from "@/lib/website-sales";
import {
  mayUseDirectAdvance,
  nextOasisLifecycleStage,
} from "@/lib/website-sales-workflow";

type Founder = {
  auth_user_id: string | null;
  email: string | null;
  full_name: string;
  display_name: string | null;
  team_role: string;
  is_owner: boolean;
};

type InitialOffer = {
  packageId: string | null;
  setupAmount: number | null;
  monthlyAmount: number | null;
  currency: string | null;
  automationIds: string[];
  paymentDueAmount: number | null;
  collectedSetupAmount: number | null;
  checkoutReference: string | null;
  checkoutUrl: string | null;
  builderUserId: string | null;
};

type Props = {
  leadId: string;
  leadName: string | null;
  leadCompany: string | null;
  leadEmail: string | null;
  leadPhone: string | null;
  leadWebsite: string | null;
  currentStage: string;
  canManage: boolean;
  canRunDeal: boolean;
  canRunDelivery: boolean;
  initialOffer?: InitialOffer;
  initialBuildBrief?: Partial<BuildBriefDraft> | null;
};

type WorkflowResponse = {
  ok?: boolean;
  error?: string;
  detail?: string;
  warning?: string;
  stageUpdated?: boolean;
  dealClosed?: boolean;
  checkoutUrl?: string;
  checkoutReference?: string;
  installmentRecorded?: boolean;
  balanceDue?: number;
};

const INPUT =
  "w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg outline-none transition focus:border-accent/70 focus:ring-1 focus:ring-accent/30";

function defaultDepositAmount(setupAmount: number): number {
  return Math.ceil(Math.max(0, setupAmount) * 100 / 2) / 100;
}

const DIRECT_ADVANCE_LABELS: Record<string, string> = {
  assigned: "Start outreach",
  won: "Begin onboarding",
  onboarding: "Move into build",
  in_build: "Send to client review",
  client_review: "Mark launched",
};
const STRUCTURED_STAGE_TARGETS = new Set([
  "qualified",
  "founder_meeting_booked",
  "proposal_sent",
  "won",
  "onboarding",
]);

export function LeadLifecycleActions({
  leadId,
  leadName,
  leadCompany,
  leadEmail,
  leadPhone,
  leadWebsite,
  currentStage,
  canManage,
  canRunDeal,
  canRunDelivery,
  initialOffer,
  initialBuildBrief,
}: Props) {
  const router = useRouter();
  const [refreshPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [transitionNote, setTransitionNote] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [lossReason, setLossReason] = useState("");
  const [dealOutcome, setDealOutcome] = useState<"follow_up" | "no_show" | "reschedule" | "lost">("follow_up");
  const [checks, setChecks] = useState([false, false, false, false]);
  const [founders, setFounders] = useState<Founder[]>([]);
  const [builders, setBuilders] = useState<Founder[]>([]);
  const [founderUserId, setFounderUserId] = useState("");
  const [meetingAt, setMeetingAt] = useState("");
  const [promisedDemo, setPromisedDemo] = useState("");
  const [calendarDraftOpened, setCalendarDraftOpened] = useState(false);
  const [calendarRequestId, setCalendarRequestId] = useState<string | null>(null);
  const initialPackageId =
    initialOffer?.packageId && initialOffer.packageId in WEBSITE_PACKAGES
      ? (initialOffer.packageId as WebsitePackageId)
      : "essential";
  const [packageId, setPackageId] = useState<WebsitePackageId>(initialPackageId);
  const [setupAmount, setSetupAmount] = useState(
    String(initialOffer?.setupAmount ?? WEBSITE_PACKAGES[initialPackageId].setupFloor),
  );
  const [monthlyAmount, setMonthlyAmount] = useState(
    String(initialOffer?.monthlyAmount ?? WEBSITE_PACKAGES[initialPackageId].monthlyFloor),
  );
  const [paymentDueAmount, setPaymentDueAmount] = useState(
    String(
      initialOffer?.paymentDueAmount ??
        defaultDepositAmount(initialOffer?.setupAmount ?? WEBSITE_PACKAGES[initialPackageId].setupFloor),
    ),
  );
  const [collectedSetupAmount, setCollectedSetupAmount] = useState(
    initialOffer?.collectedSetupAmount ?? 0,
  );
  const [currency, setCurrency] = useState(initialOffer?.currency === "USD" ? "USD" : "CAD");
  const [automationIds, setAutomationIds] = useState<string[]>(initialOffer?.automationIds || []);
  const [paymentReference, setPaymentReference] = useState(initialOffer?.checkoutReference || "");
  const [checkoutUrl, setCheckoutUrl] = useState(initialOffer?.checkoutUrl || "");
  const [builderUserId, setBuilderUserId] = useState(initialOffer?.builderUserId || "");
  const [paymentProvider, setPaymentProvider] = useState<"stripe" | "manual">("stripe");
  const [manualPaymentConfirmed, setManualPaymentConfirmed] = useState(false);
  const [correctionStage, setCorrectionStage] = useState(currentStage);

  useEffect(() => {
    fetch("/api/team/members")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const members = (body?.members || []) as Founder[];
        const next = members.filter(
          (member: Founder) => member.is_owner || ["admin", "closer"].includes(member.team_role),
        );
        setFounders(next);
        const delivery = members.filter((member) => member.team_role === "builder");
        setBuilders(delivery);
        if (next[0]?.auth_user_id) setFounderUserId(next[0].auth_user_id);
        if (!initialOffer?.builderUserId && delivery[0]?.auth_user_id) {
          setBuilderUserId(delivery[0].auth_user_id);
        }
      })
      .catch(() => setFounders([]));
  }, [initialOffer?.builderUserId]);

  useEffect(() => setCorrectionStage(currentStage), [currentStage]);

  const currentMeta = findOasisStage("lead", currentStage);
  const nextStage = nextOasisLifecycleStage(currentStage);
  const nextMeta = nextStage ? findOasisStage("lead", nextStage) : null;
  const mayAdvance =
    mayUseDirectAdvance(currentStage, canManage, canRunDeal) ||
    (canRunDelivery && ["onboarding", "in_build", "client_review"].includes(currentStage));
  const disabled = busy || refreshPending;
  const checkoutHref = safeStripeCheckoutUrl(checkoutUrl);
  const paymentCompletesSetup =
    collectedSetupAmount + Number(paymentDueAmount || 0) >= Number(setupAmount || 0);
  const showCallOutcomes = currentStage === "assigned" || currentStage === "attempting_contact";
  const mayScheduleFounderAudit = ["assigned", "attempting_contact", "connected", "qualified"].includes(
    currentStage,
  );
  const schedulingAlsoQualifies = currentStage !== "qualified";
  const postFounderRep =
    !canManage && !canRunDeal && !canRunDelivery &&
    ["founder_meeting_booked", "demo_completed", "proposal_sent", "won", "onboarding", "in_build", "client_review"].includes(
      currentStage,
    );

  async function patch(body: Record<string, unknown>, success: string): Promise<WorkflowResponse | null> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/website-sales/${leadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          // Optimistic lifecycle guard: every mutation is anchored to the
          // stage rendered in this lead file. A stale tab must refresh instead
          // of turning one intended click into a later lifecycle edge.
          expectedStage: currentStage,
          note: transitionNote.trim() || undefined,
          requestId:
            typeof body.requestId === "string" && body.requestId
              ? body.requestId
              : crypto.randomUUID(),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as WorkflowResponse;
      if (!response.ok || !json.ok) {
        if (json.stageUpdated || json.dealClosed) {
          throw new Error(
            "The lifecycle action saved, but its activity record needs an admin check. Refresh before trying again.",
          );
        }
        throw new Error(readableError(json.error || `update_${response.status}`));
      }
      if (json.installmentRecorded && typeof json.balanceDue === "number") {
        setCollectedSetupAmount((previous) => previous + Number(paymentDueAmount || 0));
        setPaymentDueAmount(String(json.balanceDue));
        setPaymentReference("");
        setCheckoutUrl("");
        setManualPaymentConfirmed(false);
      }
      setTransitionNote("");
      setMessage(json.warning ? `${success} Tracking warning: ${json.warning}.` : success);
      window.dispatchEvent(new CustomEvent("oasis:lead-touch", { detail: { leadId } }));
      startTransition(() => router.refresh());
      return json;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function choosePackage(next: WebsitePackageId) {
    setPackageId(next);
    setSetupAmount(String(WEBSITE_PACKAGES[next].setupFloor));
    const dueNow = defaultDepositAmount(WEBSITE_PACKAGES[next].setupFloor);
    setPaymentDueAmount(String(dueNow));
    setMonthlyAmount(String(WEBSITE_PACKAGES[next].monthlyFloor));
  }

  function toggleAutomation(id: string) {
    setAutomationIds((previous) =>
      previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
    );
  }

  function invalidateCalendarDraft() {
    setCalendarDraftOpened(false);
    setCalendarRequestId(null);
  }

  function setQualificationCheck(index: number, checked: boolean) {
    setChecks((previous) =>
      previous.map((value, itemIndex) => (itemIndex === index ? checked : value)),
    );
    invalidateCalendarDraft();
  }

  function openCalendarDraft() {
    const start = new Date(meetingAt);
    const hostEmail = founders.find((founder) => founder.auth_user_id === founderUserId)?.email || null;
    if (!founderUserId || !hostEmail || Number.isNaN(start.getTime()) || !promisedDemo.trim()) return;
    const calendarUrl = googleCalendarAuditUrl({
      at:start,
      leadName,
      company:leadCompany,
      email:leadEmail,
      phone:leadPhone,
      website:leadWebsite,
      promisedDemo:promisedDemo.trim(),
      handoffNote:transitionNote.trim(),
      hostEmail,
    });
    window.open(calendarUrl, "_blank", "noopener,noreferrer");
    setCalendarRequestId(crypto.randomUUID());
    setCalendarDraftOpened(true);
  }

  async function confirmCalendarHandoff() {
    const start = new Date(meetingAt);
    if (!calendarDraftOpened || !calendarRequestId || Number.isNaN(start.getTime())) return;
    await patch(
      {
        action: "book_founder",
        requestId: calendarRequestId,
        founderUserId,
        meetingAt: start.toISOString(),
        promisedDemo: promisedDemo.trim(),
        calendarConfirmed: true,
        ...(schedulingAlsoQualifies
          ? {
              qualification: {
                authorityConfirmed: true,
                websiteProblemConfirmed: true,
                timingConfirmed: true,
                minimumInvestmentConfirmed: true,
              },
            }
          : {}),
      },
      schedulingAlsoQualifies
        ? "Qualification and Calendar handoff confirmed. The lead is now in Founder Meeting."
        : "Calendar event confirmed. The audit is now assigned to the selected host.",
    );
  }

  async function createPaymentLink() {
    const result = await patch(
      { action: "create_payment_link" },
      "Lead-bound payment link created. Send this exact link to the client.",
    );
    if (result?.checkoutReference) setPaymentReference(result.checkoutReference);
    if (result?.checkoutUrl) setCheckoutUrl(result.checkoutUrl);
  }

  async function copyPaymentLink() {
    if (!checkoutHref) return;
    try {
      await navigator.clipboard.writeText(checkoutHref);
      setMessage("Payment link copied.");
    } catch {
      setMessage("Copy was blocked by the browser. Open the link and copy it from the address bar.");
    }
  }

  return (
    <section id="lead-lifecycle-control" className="scroll-mt-24 overflow-hidden rounded-2xl border border-bg-border bg-bg-deep/60">
      <div className="border-b border-bg-border bg-bg-elev/45 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-dim">
              Lifecycle control
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
              <StagePill label={currentMeta?.label || titleCase(currentStage)} color={currentMeta?.bg} />
              {nextMeta && (
                <>
                  <ArrowRight className="h-4 w-4 text-fg-dim" aria-hidden />
                  <span className="text-fg-muted">{nextMeta.label}</span>
                </>
              )}
            </div>
          </div>
          <div className="max-w-xl text-sm leading-6 text-fg-muted">
            {instructionFor(currentStage, canManage || canRunDelivery)}
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-fg-muted">
            Outcome and handoff note
          </span>
          <textarea
            value={transitionNote}
            onChange={(event) => {
              setTransitionNote(event.target.value);
              if (mayScheduleFounderAudit) invalidateCalendarDraft();
            }}
            maxLength={4000}
            rows={3}
            placeholder='Capture what the client said and any timing commitment, e.g. "Requested the founder meeting for 4:00 p.m."'
            className={INPUT}
          />
          <span className="mt-1 block text-[10px] text-fg-dim">
            Saved with the lifecycle event so the next owner sees why the lead moved.
          </span>
        </label>

        {mayAdvance && nextStage && (
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">
                  {DIRECT_ADVANCE_LABELS[currentStage] || `Move to ${nextMeta?.label || titleCase(nextStage)}`}
                </div>
                <div className="mt-1 text-xs text-fg-muted">
                  This move is recorded as a touch and appears in the timeline.
                </div>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  patch(
                    { action: "advance", to: nextStage },
                    `Moved to ${nextMeta?.label || titleCase(nextStage)}.`,
                  )
                }
                className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-sm"
              >
                {currentStage === "assigned" ? "Start outreach" : DIRECT_ADVANCE_LABELS[currentStage]}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        )}

        {showCallOutcomes && (
          <fieldset className="space-y-3 rounded-xl border border-bg-border p-4">
            <legend className="px-2 text-xs font-bold uppercase tracking-wider text-fg-muted">
              Record call outcome
            </legend>
            <label className="block text-xs text-fg-muted">
              Next follow-up time
              <input
                type="datetime-local"
                value={nextActionAt}
                onChange={(event) => setNextActionAt(event.target.value)}
                className={`${INPUT} mt-1.5 sm:max-w-xs`}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={disabled || !nextActionAt}
                onClick={() =>
                  patch(
                    {
                      action: "disposition",
                      disposition: "attempted",
                      nextActionAt: new Date(nextActionAt).toISOString(),
                    },
                    "No answer recorded and follow-up scheduled.",
                  )
                }
                className="btn-secondary !px-3 !py-2 text-xs"
              >
                No answer
              </button>
              <button
                type="button"
                disabled={disabled || !nextActionAt}
                onClick={() =>
                  patch(
                    {
                      action: "disposition",
                      disposition: "voicemail",
                      nextActionAt: new Date(nextActionAt).toISOString(),
                    },
                    "Voicemail recorded and follow-up scheduled.",
                  )
                }
                className="btn-secondary !px-3 !py-2 text-xs"
              >
                Voicemail left
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  patch({ action: "disposition", disposition: "connected" }, "Connection recorded.")
                }
                className="btn-secondary !px-3 !py-2 text-xs"
              >
                Connected
              </button>
            </div>
            <LossControl
              disabled={disabled}
              lossReason={lossReason}
              setLossReason={setLossReason}
              onLost={() =>
                patch(
                  { action: "disposition", disposition: "lost", lossReason },
                  "Lead closed as lost with the reason preserved.",
                )
              }
            />
          </fieldset>
        )}

        {currentStage === "connected" && (
          <fieldset className="space-y-4 rounded-xl border border-bg-border p-4">
            <legend className="px-2 text-xs font-bold uppercase tracking-wider text-fg-muted">
              Qualification gates
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                "Decision-maker confirmed",
                "Website problem confirmed",
                "Timing confirmed",
                "Open to $2,000+",
              ].map((label, index) => (
                <label
                  key={label}
                  className="flex items-center gap-2 rounded-lg border border-bg-border/70 bg-bg-elev/30 px-3 py-2 text-xs text-fg-muted"
                >
                  <input
                    type="checkbox"
                    checked={checks[index]}
                    onChange={(event) => setQualificationCheck(index, event.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <button
              type="button"
              disabled={disabled || !checks.every(Boolean)}
              onClick={() =>
                patch(
                  {
                    action: "qualify",
                    qualification: {
                      authorityConfirmed: true,
                      websiteProblemConfirmed: true,
                      timingConfirmed: true,
                      minimumInvestmentConfirmed: true,
                    },
                  },
                  "Qualification completed.",
                )
              }
              className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-sm"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Mark qualified
            </button>
            <LossControl
              disabled={disabled}
              lossReason={lossReason}
              setLossReason={setLossReason}
              onLost={() =>
                patch(
                  { action: "disposition", disposition: "lost", lossReason },
                  "Lead closed as lost with the reason preserved.",
                )
              }
            />
          </fieldset>
        )}

        {mayScheduleFounderAudit && (
          <fieldset id="founder-audit-handoff" className="scroll-mt-24 space-y-4 rounded-xl border border-bg-border p-4">
            <legend className="px-2 text-xs font-bold uppercase tracking-wider text-fg-muted">
              15-minute audit handoff
            </legend>
            <div className="flex items-start gap-2 text-xs leading-5 text-fg-muted">
              <Clock3 className="h-4 w-4 text-accent" aria-hidden />
              <span>
                Open the prefilled event, save it in Google Calendar, then confirm the handoff here.
                The app cannot verify a prefilled Calendar event automatically, so ownership transfers
                only after your explicit confirmation.
              </span>
            </div>
            {schedulingAlsoQualifies ? (
              <div className="space-y-3 rounded-lg border border-accent/25 bg-accent/5 p-3">
                <div>
                  <div className="text-xs font-semibold text-fg">Scheduling will also mark this lead qualified</div>
                  <p className="mt-1 text-xs leading-5 text-fg-muted">
                    Confirm every gate and write the client context in the handoff note above. Nothing moves
                    until the Calendar event is saved and you complete step 2.
                  </p>
                </div>
                {currentStage === "connected" ? (
                  <div className="text-xs text-fg-muted">
                    Use the four qualification gates in the section above; the same checks protect this handoff.
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      "Decision-maker confirmed",
                      "Website problem confirmed",
                      "Timing confirmed",
                      "Open to $2,000+",
                    ].map((label, index) => (
                      <label
                        key={`handoff-${label}`}
                        className="flex items-center gap-2 rounded-lg border border-bg-border/70 bg-bg-elev/30 px-3 py-2 text-xs text-fg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={checks[index]}
                          onChange={(event) => setQualificationCheck(index, event.target.checked)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
                {!transitionNote.trim() ? (
                  <div className="text-xs text-amber-200">
                    Add the client&apos;s needs, timing, and any promised preparation to the handoff note above.
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-fg-muted">
                Audit host
                <select
                  value={founderUserId}
                  onChange={(event) => {
                    setFounderUserId(event.target.value);
                    invalidateCalendarDraft();
                  }}
                  className={`${INPUT} mt-1.5`}
                >
                  <option value="">Select founder or closer</option>
                  {founders.map(
                    (founder) =>
                      founder.auth_user_id && (
                        <option key={founder.auth_user_id} value={founder.auth_user_id}>
                          {founder.display_name || founder.full_name}
                        </option>
                      ),
                  )}
                </select>
              </label>
              <label className="text-xs text-fg-muted">
                Meeting date and time
                <input
                  type="datetime-local"
                  value={meetingAt}
                  onChange={(event) => {
                    setMeetingAt(event.target.value);
                    invalidateCalendarDraft();
                  }}
                  className={`${INPUT} mt-1.5`}
                />
              </label>
            </div>
            <label className="block text-xs text-fg-muted">
              Promised audit or demo
              <textarea
                value={promisedDemo}
                onChange={(event) => {
                  setPromisedDemo(event.target.value);
                  invalidateCalendarDraft();
                }}
                maxLength={500}
                rows={2}
                placeholder="What must the founder show or prepare?"
                className={`${INPUT} mt-1.5`}
              />
            </label>
            {!founders.find((founder) => founder.auth_user_id === founderUserId)?.email && founderUserId ? (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
                This host has no account email. Choose another founder or closer before booking.
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={
                  disabled ||
                  !founderUserId ||
                  !meetingAt ||
                  !promisedDemo.trim() ||
                  (schedulingAlsoQualifies && (!checks.every(Boolean) || !transitionNote.trim())) ||
                  !founders.find((founder) => founder.auth_user_id === founderUserId)?.email
                }
                onClick={openCalendarDraft}
                className="btn-secondary !px-4 !py-2 text-sm"
              >
                1. Open prefilled Google Calendar
              </button>
              <button
                type="button"
                disabled={disabled || !calendarDraftOpened || !calendarRequestId}
                onClick={() => void confirmCalendarHandoff()}
                className="btn-primary !px-4 !py-2 text-sm"
              >
                2. I saved the event - complete handoff
              </button>
            </div>
          </fieldset>
        )}

        {canRunDeal && currentStage === "founder_meeting_booked" && (
          <LeadBuildBriefForm
            disabled={disabled}
            initial={initialBuildBrief}
            onSubmit={(buildBrief) =>
              void patch(
                { action: "complete_audit", buildBrief },
                "Audit completed. The builder-ready brief is now attached to pricing and fulfillment.",
              )
            }
          />
        )}

        {canRunDeal && ["founder_meeting_booked", "demo_completed", "proposal_sent"].includes(currentStage) && (
          <fieldset className="space-y-3 rounded-xl border border-bg-border p-4">
            <legend className="px-2 text-xs font-bold uppercase tracking-wider text-fg-muted">
              Meeting or deal outcome
            </legend>
            <p className="text-xs leading-5 text-fg-muted">
              If the call did not produce the next lifecycle milestone, record what happened so this deal never
              gets stuck or disappears from follow-up.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-fg-muted">
                Outcome
                <select
                  value={dealOutcome}
                  onChange={(event) =>
                    setDealOutcome(event.target.value as "follow_up" | "no_show" | "reschedule" | "lost")
                  }
                  className={`${INPUT} mt-1.5`}
                >
                  <option value="follow_up">Follow-up required</option>
                  <option value="no_show">Client no-show</option>
                  <option value="reschedule">Rescheduled</option>
                  <option value="lost">Closed lost</option>
                </select>
              </label>
              {dealOutcome !== "lost" ? (
                <label className="text-xs text-fg-muted">
                  Next follow-up or meeting
                  <input
                    type="datetime-local"
                    value={nextActionAt}
                    onChange={(event) => setNextActionAt(event.target.value)}
                    className={`${INPUT} mt-1.5`}
                  />
                </label>
              ) : (
                <label className="text-xs text-fg-muted">
                  Loss reason
                  <input
                    value={lossReason}
                    onChange={(event) => setLossReason(event.target.value)}
                    maxLength={500}
                    className={`${INPUT} mt-1.5`}
                  />
                </label>
              )}
            </div>
            <button
              type="button"
              disabled={disabled || (dealOutcome === "lost" ? !lossReason.trim() : !nextActionAt)}
              onClick={() =>
                void patch(
                  {
                    action: "deal_outcome",
                    outcome: dealOutcome,
                    nextActionAt:
                      dealOutcome === "lost" ? undefined : new Date(nextActionAt).toISOString(),
                    lossReason: dealOutcome === "lost" ? lossReason.trim() : undefined,
                  },
                  dealOutcome === "lost"
                    ? "Deal closed as lost with the reason preserved."
                    : "Outcome recorded and the next action scheduled.",
                )
              }
              className="btn-secondary !px-4 !py-2 text-sm"
            >
              Record outcome
            </button>
          </fieldset>
        )}

        {canRunDeal && currentStage === "demo_completed" && (
          <OfferFields
            disabled={disabled}
            packageId={packageId}
            choosePackage={choosePackage}
            setupAmount={setupAmount}
            setSetupAmount={(value) => {
              setSetupAmount(value);
              setPaymentDueAmount(String(defaultDepositAmount(Number(value || 0))));
            }}
            paymentDueAmount={paymentDueAmount}
            setPaymentDueAmount={setPaymentDueAmount}
            monthlyAmount={monthlyAmount}
            setMonthlyAmount={setMonthlyAmount}
            currency={currency}
            setCurrency={setCurrency}
            automationIds={automationIds}
            toggleAutomation={toggleAutomation}
            submitLabel="Record proposal sent"
            onSubmit={() =>
              patch(
                {
                  action: "proposal",
                  packageId,
                  automationIds,
                  setupAmount: Number(setupAmount),
                  paymentDueAmount: Number(paymentDueAmount),
                  monthlyAmount: Number(monthlyAmount),
                  currency,
                },
                "Proposal terms recorded and sent stage confirmed.",
              )
            }
          />
        )}

        {canRunDeal && currentStage === "proposal_sent" && (
          <div className="space-y-4 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.035] p-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                Proposal frozen — waiting for collected payment
              </div>
              <div className="mt-2 text-sm font-semibold text-fg">
                {WEBSITE_PACKAGES[packageId].name} · {currency} {Number(setupAmount).toLocaleString()} setup
                {Number(monthlyAmount) > 0 ? ` + ${Number(monthlyAmount).toLocaleString()}/month` : ""}
              </div>
              <div className="mt-1 text-sm font-semibold text-emerald-200">
                Amount due now: {currency} {Number(paymentDueAmount).toLocaleString()}
              </div>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                {collectedSetupAmount > 0
                  ? `${currency} ${collectedSetupAmount.toLocaleString()} is already verified. This balance completes the setup collection.`
                  : "The first verified deposit is recorded without opening fulfillment or commission. The balance completes the sale."}
              </p>
            </div>
            <label className="block text-xs text-fg-muted">
              Assigned builder
              <select
                value={builderUserId}
                onChange={(event) => setBuilderUserId(event.target.value)}
                className={`${INPUT} mt-1.5 sm:max-w-sm`}
              >
                <option value="">Select the builder receiving this handoff</option>
                {builders.map(
                  (builder) =>
                    builder.auth_user_id && (
                      <option key={builder.auth_user_id} value={builder.auth_user_id}>
                        {builder.display_name || builder.full_name}
                      </option>
                    ),
                )}
              </select>
            </label>
            {canManage ? (
              <label className="block text-xs text-fg-muted">
                Payment source
                <select
                  value={paymentProvider}
                  onChange={(event) => setPaymentProvider(event.target.value === "manual" ? "manual" : "stripe")}
                  className={`${INPUT} mt-1.5 sm:max-w-xs`}
                >
                  <option value="stripe">Stripe — verify with provider</option>
                  <option value="manual">Interac / wire — founder verification</option>
                </select>
              </label>
            ) : (
              <div className="text-xs text-fg-muted">Stripe verification is required for closer-submitted payments.</div>
            )}
            {paymentProvider === "stripe" ? (
              <div className="space-y-3 rounded-lg border border-bg-border bg-bg-deep/60 p-3">
                <div className="text-xs leading-5 text-fg-muted">
                  OASIS creates the live Checkout Session. It is locked to this lead, proposal,
                  currency, and amount due now; pasted Stripe IDs are not accepted.
                </div>
                <div className="flex flex-wrap gap-2">
                  {!checkoutHref ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void createPaymentLink()}
                      className="btn-secondary !px-4 !py-2 text-sm"
                    >
                      Create live payment link
                    </button>
                  ) : (
                    <>
                      <a
                        href={checkoutHref}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-secondary !px-4 !py-2 text-sm"
                      >
                        Open secure payment link
                      </a>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => void copyPaymentLink()}
                        className="btn-secondary !px-4 !py-2 text-sm"
                      >
                        Copy link
                      </button>
                    </>
                  )}
                </div>
                {paymentReference ? (
                  <div className="break-all text-[10px] text-fg-dim">Checkout: {paymentReference}</div>
                ) : null}
              </div>
            ) : (
              <label className="block text-xs text-fg-muted">
                Transfer or bank reference
                <input
                  value={paymentReference}
                  onChange={(event) => setPaymentReference(event.target.value)}
                  placeholder="Receipt / confirmation number"
                  className={`${INPUT} mt-1.5`}
                />
              </label>
            )}
            {paymentProvider === "manual" && canManage && (
              <div className="space-y-3 rounded-lg border border-bg-border bg-bg-deep/60 p-3">
                <div className="text-xs font-semibold text-fg">
                  Confirm collected amount: {currency} {Number(paymentDueAmount).toLocaleString()}
                </div>
                <label className="flex items-start gap-2 text-xs leading-5 text-fg-muted">
                  <input
                    type="checkbox"
                    checked={manualPaymentConfirmed}
                    onChange={(event) => setManualPaymentConfirmed(event.target.checked)}
                    className="mt-1"
                  />
                  I verified cleared funds match the frozen amount due now. This creates an auditable
                  founder attestation in Turso.
                </label>
              </div>
            )}
            <button
              type="button"
              disabled={
                disabled ||
                (paymentCompletesSetup && !builderUserId) ||
                !paymentReference.trim() ||
                (paymentProvider === "stripe" && !checkoutHref) ||
                (paymentProvider === "manual" && (!canManage || !manualPaymentConfirmed))
              }
              onClick={() =>
                patch(
                  {
                    action: "record_payment",
                    paymentProvider,
                    paymentReference: paymentReference.trim(),
                    paymentAmount: Number(paymentDueAmount),
                    paymentCurrency: currency,
                    manualPaymentConfirmed,
                    builderUserId,
                  },
                  paymentCompletesSetup
                    ? "Setup paid in full. Commission accrued once and the builder handoff opened."
                    : "Deposit verified. The balance is ready, with commission and fulfillment still locked.",
                )
              }
              className="btn-primary !px-4 !py-2 text-sm"
            >
              {paymentCompletesSetup ? "Verify balance & start fulfillment" : "Verify setup deposit"}
            </button>
          </div>
        )}

        {postFounderRep && (
          <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-sm text-fg-muted">
            Your handoff is complete. Founders and delivery owners control this phase; every update remains
            visible in the timeline.
          </div>
        )}

        {(currentStage === "lost" || currentStage === "launched") && (
          <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-sm text-fg-muted">
            {currentStage === "lost"
              ? "This lead is closed as lost. An admin can correct the stage below with a required reason."
              : "Lifecycle complete. The client has launched."}
          </div>
        )}

        {canManage && (
          <details className="rounded-xl border border-bg-border bg-bg-elev/20 p-4">
            <summary className="cursor-pointer text-xs font-semibold text-fg-muted">
              Admin stage correction
            </summary>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <select
                value={correctionStage}
                onChange={(event) => setCorrectionStage(event.target.value)}
                className={INPUT}
              >
                {OASIS_LEAD_STAGES.filter(
                  (stage) => stage.key === currentStage || !STRUCTURED_STAGE_TARGETS.has(stage.key),
                ).map((stage) => (
                  <option key={stage.key} value={stage.key}>
                    {stage.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={
                  disabled || correctionStage === currentStage || transitionNote.trim().length === 0
                }
                onClick={() =>
                  patch(
                    { action: "set_stage", stage: correctionStage },
                    `Stage corrected to ${findOasisStage("lead", correctionStage)?.label || titleCase(correctionStage)}.`,
                  )
                }
                className="btn-secondary shrink-0 !px-4 !py-2 text-xs"
              >
                Apply correction
              </button>
            </div>
            <div className="mt-2 text-[10px] text-fg-dim">
              A correction requires the outcome and handoff note above. Use the guided action whenever possible.
            </div>
          </details>
        )}

        {message && (
          <div
            role="status"
            className="rounded-lg border border-bg-border bg-bg-elev/40 px-3 py-2 text-xs text-fg-muted"
          >
            {message}
          </div>
        )}
      </div>
    </section>
  );
}

function LossControl({
  disabled,
  lossReason,
  setLossReason,
  onLost,
}: {
  disabled: boolean;
  lossReason: string;
  setLossReason: (value: string) => void;
  onLost: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-bg-border/60 pt-3 sm:flex-row">
      <input
        value={lossReason}
        onChange={(event) => setLossReason(event.target.value)}
        maxLength={500}
        placeholder="Loss reason (required)"
        className={INPUT}
      />
      <button
        type="button"
        disabled={disabled || !lossReason.trim()}
        onClick={onLost}
        className="btn-secondary shrink-0 !border-red-400/30 !px-3 !py-2 text-xs !text-red-300"
      >
        Close as lost
      </button>
    </div>
  );
}

function OfferFields({
  disabled,
  packageId,
  choosePackage,
  setupAmount,
  setSetupAmount,
  paymentDueAmount,
  setPaymentDueAmount,
  monthlyAmount,
  setMonthlyAmount,
  currency,
  setCurrency,
  automationIds,
  toggleAutomation,
  submitLabel,
  onSubmit,
}: {
  disabled: boolean;
  packageId: WebsitePackageId;
  choosePackage: (value: WebsitePackageId) => void;
  setupAmount: string;
  setSetupAmount: (value: string) => void;
  paymentDueAmount: string;
  setPaymentDueAmount: (value: string) => void;
  monthlyAmount: string;
  setMonthlyAmount: (value: string) => void;
  currency: string;
  setCurrency: (value: string) => void;
  automationIds: string[];
  toggleAutomation: (id: string) => void;
  submitLabel?: string;
  onSubmit?: () => void;
}) {
  const offer = WEBSITE_PACKAGES[packageId];
  return (
    <fieldset className="space-y-4 rounded-xl border border-bg-border p-4">
      <legend className="px-2 text-xs font-bold uppercase tracking-wider text-fg-muted">
        Commercial terms
      </legend>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="text-xs text-fg-muted">
          Package
          <select
            value={packageId}
            onChange={(event) => choosePackage(event.target.value as WebsitePackageId)}
            className={`${INPUT} mt-1.5`}
          >
            {Object.values(WEBSITE_PACKAGES).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-muted">
          Setup amount
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={setupAmount}
            onChange={(event) => setSetupAmount(event.target.value)}
            className={`${INPUT} mt-1.5`}
          />
        </label>
        <label className="text-xs text-fg-muted">
          Amount due now
          <input
            type="number"
            min="0.01"
            step="0.01"
            max={setupAmount || undefined}
            value={paymentDueAmount}
            onChange={(event) => setPaymentDueAmount(event.target.value)}
            className={`${INPUT} mt-1.5`}
          />
          <span className="mt-1 block text-[10px] leading-4 text-fg-dim">
            Defaults to a 50% setup deposit. Commission and fulfillment open only after verified receipts total the full setup price.
          </span>
        </label>
        <label className="text-xs text-fg-muted">
          Monthly amount
          <input
            type="number"
            min="0"
            value={monthlyAmount}
            onChange={(event) => setMonthlyAmount(event.target.value)}
            className={`${INPUT} mt-1.5`}
          />
        </label>
        <label className="text-xs text-fg-muted">
          Currency
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            className={`${INPUT} mt-1.5`}
          >
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </select>
        </label>
      </div>
      <div className="text-[10px] text-fg-dim">
        {offer.name} floor: {offer.setupFloor.toLocaleString()} setup + {offer.monthlyFloor.toLocaleString()}/month.
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {AUTOMATION_ADD_ONS.map((automation) => (
          <label
            key={automation.id}
            className="flex items-start gap-2 rounded-lg border border-bg-border/70 bg-bg-elev/30 px-3 py-2 text-xs text-fg-muted"
          >
            <input
              type="checkbox"
              checked={automationIds.includes(automation.id)}
              onChange={() => toggleAutomation(automation.id)}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium text-fg">{automation.name}</span>
              <span className="mt-0.5 block text-[10px] text-fg-dim">{automation.delivers}</span>
            </span>
          </label>
        ))}
      </div>
      {submitLabel && onSubmit && (
        <button
          type="button"
          disabled={
            disabled ||
            !setupAmount ||
            !paymentDueAmount ||
            Number(paymentDueAmount) <= 0 ||
            Number(paymentDueAmount) > Number(setupAmount) ||
            !monthlyAmount
          }
          onClick={onSubmit}
          className="btn-primary !px-4 !py-2 text-sm"
        >
          {submitLabel}
        </button>
      )}
    </fieldset>
  );
}

function StagePill({ label, color }: { label: string; color?: string }) {
  return (
    <span
      className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold text-white"
      style={{ background: color || "#414957" }}
    >
      {label}
    </span>
  );
}

function instructionFor(stage: string, admin: boolean): string {
  const rep: Record<string, string> = {
    assigned: "Review the website context, start outreach, and record the first outcome.",
    attempting_contact: "Make the scheduled touch and record exactly what happened.",
    connected: "Confirm the business problem, authority, timing, and investment floor.",
    qualified: "Book the founder meeting and preserve the exact time and promised demo.",
    founder_meeting_booked: "Handoff complete. The founder owns scope, price, and close.",
  };
  const manager: Record<string, string> = {
    founder_meeting_booked: "Run the meeting, capture the outcome, then mark the demo complete.",
    demo_completed: "Record the approved package, automations, and exact proposal values.",
    proposal_sent: "Close only after payment is confirmed and attribution is complete.",
    won: "Transfer the signed client into onboarding.",
    onboarding: "Confirm intake is complete before moving into build.",
    in_build: "Move to client review when the deliverable is ready for feedback.",
    client_review: "Mark launched only when the live release is confirmed.",
  };
  if (admin && manager[stage]) return manager[stage];
  return rep[stage] || "Use the guided lifecycle action and preserve the outcome for the next owner.";
}

function readableError(code: string): string {
  const known: Record<string, string> = {
    next_action_required: "Choose the next follow-up time.",
    next_action_must_be_in_future: "The next follow-up must be in the future.",
    loss_reason_required: "Enter a reason before closing the lead as lost.",
    qualification_incomplete: "Complete all four qualification gates.",
    qualification_context_required: "Add the client's needs and timing to the handoff note before scheduling early.",
    qualify_before_booking: "Complete all four qualification gates before booking the founder audit.",
    meeting_must_be_in_future: "The founder meeting must be in the future.",
    invalid_handoff: "Choose a founder, meeting time, and promised demo.",
    calendar_confirmation_required: "Save the prefilled Google Calendar event before completing the handoff.",
    transition_note_required: "Explain the reason before applying an admin stage correction.",
    use_structured_lifecycle_action: "Use the structured action for this phase.",
    founder_only: "A founder or authorized closer must complete this action.",
    founder_or_closer_only: "The assigned closer or a founder must complete the audit.",
    founder_meeting_required: "Book the 15-minute audit before capturing the build brief.",
    audit_host_not_authorized: "Choose an active founder or closer as the audit host.",
    audit_host_lookup_failed: "The audit-host list is temporarily unavailable. Refresh before confirming the handoff.",
    audit_host_email_required: "The selected founder or closer needs an account email before the Calendar handoff.",
    demo_before_proposal: "Complete the founder demo before recording a proposal.",
    builder_handoff_not_ready: "Complete every required build-brief field before pricing.",
    builder_required: "Choose the builder who will receive the paid client and complete brief.",
    builder_not_authorized: "Choose an active builder from this account.",
    proposal_before_close: "Record the proposal before closing the deal.",
    stored_proposal_incomplete: "The frozen proposal is incomplete. Return it to pricing for correction.",
    stripe_not_connected: "Stripe is not connected for this account. A founder can verify a manual transfer instead.",
    payment_link_required: "Create the lead-bound live payment link before verifying Stripe payment.",
    invalid_stripe_payment_reference: "Enter a Stripe PaymentIntent, Checkout Session, Charge, or Invoice ID.",
    stripe_payment_not_found: "Stripe could not find that payment ID.",
    stripe_verification_failed: "Stripe verification is temporarily unavailable. Try again before moving the deal.",
    payment_not_collected: "Stripe has not marked this payment as collected.",
    payment_refunded: "This Stripe collection was refunded and cannot open fulfillment.",
    payment_disputed: "This Stripe collection is disputed and cannot open fulfillment.",
    stripe_test_payment_not_accepted: "A Stripe test payment cannot close a live deal.",
    payment_not_bound_to_lead: "This payment does not belong to this lead and frozen proposal.",
    payment_does_not_match_proposal: "The collected amount or currency does not match the frozen proposal.",
    manual_payment_confirmation_required: "A founder must confirm that the funds cleared.",
    manual_payment_founder_only: "Only a founder can verify a non-Stripe payment.",
    payment_reference_already_used: "That payment reference is already attached to another deal.",
    verified_payment_required: "A verified payment receipt is required before commission can accrue.",
    use_verified_payment_action: "Verify the collected payment before moving this deal to fulfillment.",
    loss_reason_too_long: "Keep the loss reason under 500 characters.",
    expected_stage_required: "Refresh the lead before changing its lifecycle.",
    stage_changed_refresh: "This lead moved in another session. Refresh before continuing.",
    request_id_reused_for_different_lead: "This handoff request belongs to another lead. Refresh and try again.",
    request_id_reused_for_different_action: "This handoff request was already used for another action. Refresh and try again.",
  };
  return known[code] || code.replaceAll("_", " ");
}

function googleCalendarAuditUrl(input: {
  at: Date;
  leadName: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  promisedDemo: string;
  handoffNote: string;
  hostEmail: string;
}): string {
  const end = new Date(input.at.getTime() + 15 * 60_000);
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const label = input.company || input.leadName || "Lead";
  const details = [
    "15-minute OASIS website audit",
    input.leadName ? `Contact: ${input.leadName}` : null,
    input.phone ? `Phone: ${input.phone}` : null,
    input.website ? `Website: ${input.website}` : null,
    `Prepare: ${input.promisedDemo}`,
    input.handoffNote ? `Opener handoff: ${input.handoffNote}` : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
  const params = new URLSearchParams({
    action:"TEMPLATE",
    text:`OASIS audit — ${label}`,
    dates:`${stamp(input.at)}/${stamp(end)}`,
    details,
  });
  if (input.email) params.append("add", input.email);
  params.append("add", input.hostEmail);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function safeStripeCheckoutUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
