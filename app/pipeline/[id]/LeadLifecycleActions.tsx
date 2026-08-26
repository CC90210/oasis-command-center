"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, CheckCircle2, Clock3 } from "lucide-react";
import {
  LeadBuildBriefForm,
  type BuildBriefDraft,
} from "@/components/leads/LeadBuildBriefForm";
import { OASIS_LEAD_STAGES, findOasisStage } from "@/lib/oasis-stage-meta";
import { mayHostAuditCall } from "@/lib/team-roles";
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
  calendar_ready?: boolean | null;
  calendar_connected?: boolean | null;
  calendar_identity_mismatch?: boolean | null;
  connected_google_address?: string | null;
};

type FounderBookingContact = {
  name: string;
  company: string;
  email: string;
  phone: string;
  website: string;
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
const FOUNDER_TIMEZONE = "America/Toronto";
const FOUNDER_TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const hours = Math.floor(index / 4);
  const minutes = (index % 4) * 15;
  const value = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const labelHours = hours % 12 || 12;
  const suffix = hours < 12 ? "a.m." : "p.m.";
  return { value, label: `${labelHours}:${String(minutes).padStart(2, "0")} ${suffix}` };
});
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function defaultDepositAmount(setupAmount: number): number {
  return Math.ceil(Math.max(0, setupAmount) * 100 / 2) / 100;
}

function founderDateChoice(daysFromToday: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: FOUNDER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const shifted = new Date(
    Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + daysFromToday),
  );
  return shifted.toISOString().slice(0, 10);
}

function founderMeetingIso(date: string, time: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !timeMatch) return null;

  const target = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
  const targetStamp = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
  );
  let instant = targetStamp;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: FOUNDER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    );
    const observedStamp = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    instant += targetStamp - observedStamp;
  }

  const verified = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  if (
    Number(verified.year) !== target.year ||
    Number(verified.month) !== target.month ||
    Number(verified.day) !== target.day ||
    Number(verified.hour) !== target.hour ||
    Number(verified.minute) !== target.minute
  ) {
    return null;
  }
  return new Date(instant).toISOString();
}

function founderMeetingPreview(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FOUNDER_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function LifecycleDateTimeFields({
  label,
  date,
  time,
  onDateChange,
  onTimeChange,
}: {
  label: string;
  date: string;
  time: string;
  onDateChange: (value: string) => void;
  onTimeChange: (value: string) => void;
}) {
  const iso = founderMeetingIso(date, time);
  const preview = founderMeetingPreview(iso);
  const future = Boolean(iso && Date.parse(iso) > Date.now());
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-fg-muted">
          {label} date
          <input
            type="date"
            value={date}
            min={founderDateChoice(0)}
            onChange={(event) => onDateChange(event.target.value)}
            className={`${INPUT} mt-1.5`}
          />
        </label>
        <label className="text-xs font-semibold text-fg-muted">
          Time (15-minute intervals)
          <select
            value={time}
            onChange={(event) => onTimeChange(event.target.value)}
            className={`${INPUT} mt-1.5`}
          >
            <option value="">Select a time</option>
            {FOUNDER_TIME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {[{ label: "Today", days: 0 }, { label: "Tomorrow", days: 1 }, { label: "In 2 days", days: 2 }].map(
          (choice) => (
            <button
              key={choice.label}
              type="button"
              onClick={() => onDateChange(founderDateChoice(choice.days))}
              className="rounded-md border border-bg-border bg-bg-deep px-2.5 py-1 text-[11px] font-semibold text-fg-muted transition hover:border-accent/50 hover:text-fg"
            >
              {choice.label}
            </button>
          ),
        )}
        <span className="text-[11px] text-fg-dim">America/Toronto (Eastern Time)</span>
      </div>
      {preview && future ? (
        <div className="text-xs font-semibold text-accent">Scheduled: {preview}</div>
      ) : preview ? (
        <div className="text-xs text-amber-200">That time has already passed. Choose a future time.</div>
      ) : date && time ? (
        <div className="text-xs text-amber-200">That local time is not available. Choose another time.</div>
      ) : null}
    </div>
  );
}

const DIRECT_ADVANCE_LABELS: Record<string, string> = {
  assigned: "Start outreach",
  won: "Begin onboarding",
  onboarding: "Move into build",
  in_build: "Send to client review",
  client_review: "Mark launched",
};

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
  const [nextActionDate, setNextActionDate] = useState(() => founderDateChoice(0));
  const [nextActionTime, setNextActionTime] = useState("");
  const [lossReason, setLossReason] = useState("");
  const [dealOutcome, setDealOutcome] = useState<"follow_up" | "no_show" | "reschedule" | "lost">("follow_up");
  const [outcomeConfirmed, setOutcomeConfirmed] = useState(false);
  const [dealOutcomeRequestId, setDealOutcomeRequestId] = useState(() => crypto.randomUUID());
  const [checks, setChecks] = useState([false, false, false, false]);
  const [founders, setFounders] = useState<Founder[]>([]);
  const [builders, setBuilders] = useState<Founder[]>([]);
  const [founderUserId, setFounderUserId] = useState("");
  const [meetingDate, setMeetingDate] = useState(() => founderDateChoice(1));
  const [meetingTime, setMeetingTime] = useState("");
  const [promisedDemo, setPromisedDemo] = useState("");
  const [founderBookingRequestId, setFounderBookingRequestId] = useState(() => crypto.randomUUID());
  const [bookingContact, setBookingContact] = useState<FounderBookingContact>({
    name: leadName || "",
    company: leadCompany || "",
    email: leadEmail || "",
    phone: leadPhone || "",
    website: leadWebsite || "",
  });
  const [contactConfirmed, setContactConfirmed] = useState(false);
  const [clientAgreedToTime, setClientAgreedToTime] = useState(false);
  const [handoffComplete, setHandoffComplete] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
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

  // Whether a shared OASIS workspace calendar can carry a booking for a host
  // who has not connected their own Google account. A DIFFERENT fact from
  // `calendar_connected`, which is about this host specifically -- the two used
  // to be OR'd together server-side, which made every host look ready whenever
  // this global was configured. See app/api/team/members/route.ts.
  const [systemCalendarFallback, setSystemCalendarFallback] = useState(false);

  useEffect(() => {
    fetch("/api/team/members")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        setSystemCalendarFallback(body?.system_calendar_fallback === true);
        const members = (body?.members || []) as Founder[];
        const next = members.filter(
          (member: Founder) => member.is_owner || mayHostAuditCall(member.team_role),
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
  const selectedFounder = founders.find((founder) => founder.auth_user_id === founderUserId) || null;
  /**
   * TWO DIFFERENT QUESTIONS, AND CONFLATING THEM BROKE BOOKING TWICE IN A DAY.
   *
   *   ...Connected — is THIS HOST's own Google connection alive? Drives the
   *                  BANNER, which must stay honest about the host.
   *   ...CanBook   — can a booking be created AT ALL? Drives the BUTTON, and is
   *                  true when the host is connected OR the shared OASIS
   *                  workspace calendar is configured to carry it.
   *
   * HISTORY, because both mistakes were the same mistake in opposite directions.
   * Originally one boolean OR'd the workspace fallback into the host's status,
   * so every host showed "ready for this host" even with nothing connected --
   * the banner lied. PR #322 removed the fallback from that boolean, which made
   * the banner truthful and SILENTLY DISABLED THE BUTTON: a host with no
   * personal connection now read `false`, and the gate below refuses on `false`.
   * So the UI told the rep the shared calendar would carry the booking while the
   * button sat greyed out. (Caught by CC's agent, 2026-08-26.)
   *
   * The backend has been able to do this the whole time -- openAuthorizedCalendarSession
   * falls back to the workspace identity, including for a REVOKED host token
   * since #324. The gate was simply asking the wrong question.
   */
  const selectedFounderCalendarConnected =
    selectedFounder?.calendar_ready ?? selectedFounder?.calendar_connected ?? null;
  const selectedFounderCalendarReady = selectedFounderCalendarConnected;
  const founderCanBook =
    selectedFounderCalendarConnected === true ||
    (selectedFounderCalendarConnected !== null && systemCalendarFallback);
  const founderMeetingAt = founderMeetingIso(meetingDate, meetingTime);
  const nextActionAt = founderMeetingIso(nextActionDate, nextActionTime);
  const founderMeetingLabel = founderMeetingPreview(founderMeetingAt);
  const founderMeetingIsFuture =
    Boolean(founderMeetingAt) && new Date(founderMeetingAt as string).getTime() > Date.now();
  const founderContactValid =
    Boolean(bookingContact.name.trim() || bookingContact.company.trim()) &&
    EMAIL_PATTERN.test(bookingContact.email.trim());
  const founderQualification = {
    authorityConfirmed: currentStage === "qualified" ? true : checks[0],
    websiteProblemConfirmed: currentStage === "qualified" ? true : checks[1],
    timingConfirmed: currentStage === "qualified" ? true : checks[2],
    minimumInvestmentConfirmed: currentStage === "qualified" ? true : checks[3],
  };
  const effectiveContactConfirmed = contactConfirmed || founderContactValid;
  const effectiveClientAgreedToTime =
    clientAgreedToTime || (Boolean(founderMeetingAt) && founderMeetingIsFuture);
  const effectiveHandoffComplete = handoffComplete || Boolean(transitionNote.trim());
  const founderBookingReady =
    Boolean(founderUserId && founderMeetingAt && promisedDemo.trim() && transitionNote.trim()) &&
    founderMeetingIsFuture &&
    founderContactValid &&
    Object.values(founderQualification).every(Boolean) &&
    effectiveContactConfirmed &&
    effectiveClientAgreedToTime &&
    effectiveHandoffComplete &&
    // THE BUTTON ASKS "can a booking be created", not "is this host connected".
    // See the founderCanBook comment above: the shared workspace calendar can
    // carry it, and refusing here left the rep staring at a disabled button
    // under a banner that said the shared calendar would handle it.
    founderCanBook !== false;
  const bookingBlockedReason = (() => {
    if (!founderUserId) return "Select a founder or closer as host";
    if (!founderMeetingAt) return "Select meeting date and time";
    if (!founderMeetingIsFuture) return "Meeting time must be in the future";
    if (!promisedDemo.trim()) return "Enter client-facing meeting agenda";
    if (!transitionNote.trim()) return "Add internal founder handoff note";
    if (!founderContactValid) return "Enter a valid client email";
    if (!Object.values(founderQualification).every(Boolean)) return "Complete qualification gates above";
    if (founderCanBook === false)
      return "Selected host must reconnect Google, and no shared workspace calendar is configured";
    return null;
  })();
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

  function renewFounderBookingRequest() {
    setFounderBookingRequestId(crypto.randomUUID());
  }

  function renewDealOutcomeRequest() {
    setDealOutcomeRequestId(crypto.randomUUID());
  }

  function updateNextActionDate(value: string) {
    setNextActionDate(value);
    setOutcomeConfirmed(false);
    renewDealOutcomeRequest();
  }

  function updateNextActionTime(value: string) {
    setNextActionTime(value);
    setOutcomeConfirmed(false);
    renewDealOutcomeRequest();
  }

  function setQualificationCheck(index: number, checked: boolean) {
    setChecks((previous) =>
      previous.map((value, itemIndex) => (itemIndex === index ? checked : value)),
    );
    renewFounderBookingRequest();
  }

  function updateBookingContact(field: keyof FounderBookingContact, value: string) {
    setBookingContact((current) => ({ ...current, [field]: value }));
    setContactConfirmed(false);
    if (field === "phone") setSmsConsent(false);
    renewFounderBookingRequest();
  }

  async function bookFounderMeeting() {
    if (!founderMeetingAt || !founderBookingReady) return;
    const result = await patch(
      {
        action: "book_founder",
        requestId: founderBookingRequestId,
        founderUserId,
        meetingAt: founderMeetingAt,
        timezone: FOUNDER_TIMEZONE,
        promisedDemo: promisedDemo.trim(),
        note: transitionNote.trim(),
        contact: {
          name: bookingContact.name.trim(),
          company: bookingContact.company.trim(),
          email: bookingContact.email.trim(),
          phone: bookingContact.phone.trim(),
          website: bookingContact.website.trim(),
        },
        qualification: {
          authorityConfirmed: founderQualification.authorityConfirmed,
          websiteProblemConfirmed: founderQualification.websiteProblemConfirmed,
          timingConfirmed: founderQualification.timingConfirmed,
          minimumInvestmentConfirmed: founderQualification.minimumInvestmentConfirmed,
        },
        // Send the effective values the readiness gate evaluated: when a rep
        // relies on implicit confirmation (valid email, future time, written
        // handoff note), raw checkbox state would still be false and the
        // server's strict true-check would reject an otherwise valid booking.
        confirmations: {
          contactConfirmed: effectiveContactConfirmed,
          clientAgreedToTime: effectiveClientAgreedToTime,
          handoffComplete: effectiveHandoffComplete,
        },
        smsConsent: Boolean(bookingContact.phone.trim() && smsConsent),
      },
      schedulingAlsoQualifies
        ? "Meeting booked, Google invite sent, and qualification handed to the founder."
        : "Meeting booked and the verified Google invite was sent to the client.",
    );
    if (!result) return;
    setFounderBookingRequestId(crypto.randomUUID());
  }

  async function createPaymentLink() {
    const result = await patch(
      { action: "create_payment_link" },
      "Lead-bound payment link created. Send this exact link to the client.",
    );
    if (result?.checkoutReference) setPaymentReference(result.checkoutReference);
    if (result?.checkoutUrl) setCheckoutUrl(result.checkoutUrl);
  }

  async function recordDealOutcome() {
    const result = await patch(
      {
        action: "deal_outcome",
        requestId: dealOutcomeRequestId,
        outcome: dealOutcome,
        outcomeConfirmed,
        nextActionAt: dealOutcome === "lost" ? undefined : nextActionAt,
        lossReason: dealOutcome === "lost" ? lossReason.trim() : undefined,
      },
      dealOutcome === "lost"
        ? "Deal closed as lost. Any active future invite was cancelled; completed meeting history was preserved."
        : dealOutcome === "reschedule"
          ? "The existing Google invite was updated and reminders now use the new time."
          : dealOutcome === "no_show"
            ? "No-show recorded, remaining meeting reminders stopped, and follow-up scheduled."
            : "Outcome recorded and the next action scheduled.",
    );
    if (!result) return;
    setOutcomeConfirmed(false);
    renewDealOutcomeRequest();
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
              {canManage ? (
                <select
                  aria-label="Move lead to stage"
                  title="Move this lead to any OASIS lifecycle stage"
                  value={currentStage}
                  disabled={disabled}
                  onChange={(event) => {
                    const stage = event.target.value;
                    if (!stage || stage === currentStage) return;
                    const meta = findOasisStage("lead", stage);
                    void patch(
                      { action: "set_stage", stage },
                      `Stage moved to ${meta?.label || titleCase(stage)}.`,
                    );
                  }}
                  className="rounded-lg border border-bg-border bg-bg-deep px-2.5 py-1.5 text-xs font-semibold text-fg outline-none transition hover:border-accent/50 focus:border-accent/70 focus:ring-1 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {OASIS_LEAD_STAGES.map((stage) => (
                    <option key={stage.key} value={stage.key}>
                      {stage.label}
                    </option>
                  ))}
                </select>
              ) : null}
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
            {mayScheduleFounderAudit ? "Internal founder handoff note" : "Outcome and handoff note"}
          </span>
          <textarea
            value={transitionNote}
            onChange={(event) => {
              setTransitionNote(event.target.value);
              if (mayScheduleFounderAudit) {
                setHandoffComplete(false);
                renewFounderBookingRequest();
              }
              if (canRunDeal && ["founder_meeting_booked", "demo_completed", "proposal_sent"].includes(currentStage)) {
                setOutcomeConfirmed(false);
                renewDealOutcomeRequest();
              }
            }}
            maxLength={4000}
            rows={3}
            placeholder='Capture what the client said and any timing commitment, e.g. "Requested the founder meeting for 4:00 p.m."'
            className={INPUT}
          />
          <span className="mt-1 block text-[10px] text-fg-dim">
            {mayScheduleFounderAudit
              ? "Required for the founder handoff. This internal context is saved to the lead and never sent to the client."
              : "Saved with the lifecycle event so the next owner sees why the lead moved."}
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
            <div className="block text-xs text-fg-muted">
              <LifecycleDateTimeFields
                label="Next follow-up"
                date={nextActionDate}
                time={nextActionTime}
                onDateChange={updateNextActionDate}
                onTimeChange={updateNextActionTime}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={disabled || !nextActionAt}
                onClick={() =>
                  patch(
                    {
                      action: "disposition",
                      disposition: "attempted",
                      nextActionAt,
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
                      nextActionAt,
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
                <QualificationGateCard
                  key={label}
                  label={label}
                  checked={checks[index]}
                  disabled={disabled}
                  onChange={(checked) => setQualificationCheck(index, checked)}
                />
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
                Confirm the client, host, date, and handoff once. The server creates the Google Calendar
                event and Meet link, sends the client invite, records the touch, and then moves the lead.
              </span>
            </div>
            {schedulingAlsoQualifies ? (
              <div className="space-y-3 rounded-lg border border-accent/25 bg-accent/5 p-3">
                <div>
                  <div className="text-xs font-semibold text-fg">Scheduling will also mark this lead qualified</div>
                  <p className="mt-1 text-xs leading-5 text-fg-muted">
                    Confirm every gate and write the client context in the handoff note above. Nothing moves
                    until the booking and invite are verified by the server.
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
                      <QualificationGateCard
                        key={`handoff-${label}`}
                        label={label}
                        checked={checks[index]}
                        disabled={disabled}
                        onChange={(checked) => setQualificationCheck(index, checked)}
                      />
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
            <div className="grid gap-4 rounded-xl border border-bg-border/70 bg-bg-elev/20 p-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <div>
                <label className="text-xs font-semibold text-fg-muted">
                  Founder or closer hosting
                  <select
                    value={founderUserId}
                    onChange={(event) => {
                      setFounderUserId(event.target.value);
                      renewFounderBookingRequest();
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
                {typeof selectedFounderCalendarReady === "boolean" ? (
                  <div
                    /*
                     * THREE STATES NEED THREE COLOURS. This was a two-way
                     * emerald/amber pick, so the workspace-calendar case -- which
                     * is a WORKING, EXPECTED, BOOKABLE state -- rendered in the
                     * same amber as "this is broken". The operator read the
                     * screen exactly as it was painted and reported the calendar
                     * as non-functional when it was about to book correctly.
                     *
                     * Amber is now reserved for the one state that genuinely
                     * blocks a booking. The shared-calendar path gets a neutral
                     * informational blue: it is how this tenant books by default,
                     * not a fault to be fixed.
                     */
                    className={`mt-2 rounded-md border px-2.5 py-2 text-[11px] ${
                      selectedFounderCalendarReady
                        ? "border-emerald-400/25 bg-emerald-400/5 text-emerald-200"
                        : founderCanBook
                          ? "border-sky-400/25 bg-sky-400/5 text-sky-200"
                          : "border-amber-400/30 bg-amber-400/5 text-amber-200"
                    }`}
                  >
                    {/* Three DIFFERENT states, because they carry three
                        different promises and used to be one boolean:
                        the host's own verified connection; nobody's connection
                        but a shared workspace calendar that can still carry the
                        booking (organised by the shared account, not the host);
                        and genuinely not bookable. The middle case used to
                        render as "ready for this host", which was not true of
                        the host at all. */}
                    {selectedFounderCalendarReady
                      ? "Google Calendar is ready for this host."
                      : systemCalendarFallback
                        ? // LEADS WITH THE OUTCOME, NOT THE DEFICIENCY. The old
                          // wording opened "This host has not connected Google",
                          // which describes a missing thing rather than the
                          // working thing, and reads as an error even though the
                          // booking is about to succeed. Booking from the OASIS
                          // calendar is the DEFAULT operating mode for this
                          // tenant; the organiser identity is still stated,
                          // because a rep should never be surprised by whose name
                          // the client sees on the invite.
                          "Ready to book from the OASIS AI calendar. The client gets the Calendar invite and Meet link, and the OASIS AI account appears as the organiser."
                        : selectedFounder?.calendar_identity_mismatch
                          ? `This host connected ${selectedFounder.connected_google_address || "a different Google account"}. They must reconnect with ${selectedFounder.email || "their OASIS work email"} before client invitations can be sent.`
                          : "This host needs to reconnect Google Calendar before a booking can be created."}
                  </div>
                ) : null}
              </div>

              <div className="space-y-2">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
                  <label className="text-xs font-semibold text-fg-muted">
                    Meeting date
                    <input
                      type="date"
                      value={meetingDate}
                      min={founderDateChoice(0)}
                      onChange={(event) => {
                        setMeetingDate(event.target.value);
                        setClientAgreedToTime(false);
                        renewFounderBookingRequest();
                      }}
                      className={`${INPUT} mt-1.5`}
                    />
                  </label>
                  <label className="text-xs font-semibold text-fg-muted">
                    Time (15-minute intervals)
                    <select
                      value={meetingTime}
                      onChange={(event) => {
                        setMeetingTime(event.target.value);
                        setClientAgreedToTime(false);
                        renewFounderBookingRequest();
                      }}
                      className={`${INPUT} mt-1.5`}
                    >
                      <option value="">Select a time</option>
                      {FOUNDER_TIME_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {[{ label: "Today", days: 0 }, { label: "Tomorrow", days: 1 }, { label: "In 2 days", days: 2 }].map(
                    (choice) => (
                      <button
                        key={choice.label}
                        type="button"
                        onClick={() => {
                          setMeetingDate(founderDateChoice(choice.days));
                          setClientAgreedToTime(false);
                          renewFounderBookingRequest();
                        }}
                        className="rounded-md border border-bg-border bg-bg-deep px-2.5 py-1 text-[11px] font-semibold text-fg-muted transition hover:border-accent/50 hover:text-fg"
                      >
                        {choice.label}
                      </button>
                    ),
                  )}
                  <span className="text-[11px] text-fg-dim">America/Toronto (Eastern Time)</span>
                </div>
                {founderMeetingLabel && founderMeetingIsFuture ? (
                  <div className="text-xs font-semibold text-accent">Booking: {founderMeetingLabel}</div>
                ) : founderMeetingLabel ? (
                  <div className="text-xs text-amber-200">That time has already passed. Choose a future time.</div>
                ) : meetingDate && meetingTime ? (
                  <div className="text-xs text-amber-200">That local time is not available. Choose another time.</div>
                ) : null}
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-bg-border/70 bg-bg-elev/20 p-3">
              <div>
                <div className="text-xs font-semibold text-fg">Confirm contact and business</div>
                <p className="mt-1 text-[11px] leading-5 text-fg-muted">
                  Correct anything the opener learned on the call. These details are saved with the handoff and
                  the email address receives the Calendar invite.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <BookingContactField
                  label="Contact name"
                  value={bookingContact.name}
                  onChange={(value) => updateBookingContact("name", value)}
                />
                <BookingContactField
                  label="Business"
                  value={bookingContact.company}
                  onChange={(value) => updateBookingContact("company", value)}
                />
                <BookingContactField
                  label="Email for invite"
                  value={bookingContact.email}
                  type="email"
                  required
                  onChange={(value) => updateBookingContact("email", value)}
                />
                <BookingContactField
                  label="Phone"
                  value={bookingContact.phone}
                  type="tel"
                  onChange={(value) => updateBookingContact("phone", value)}
                />
                <BookingContactField
                  label="Website"
                  value={bookingContact.website}
                  type="url"
                  onChange={(value) => updateBookingContact("website", value)}
                  className="sm:col-span-2"
                />
              </div>
              {bookingContact.email.trim() && !EMAIL_PATTERN.test(bookingContact.email.trim()) ? (
                <div className="text-xs text-amber-200">Enter a valid client email so the invite can be delivered.</div>
              ) : null}
            </div>

            <label className="block text-xs font-semibold text-fg-muted">
              Client-facing meeting agenda
              <textarea
                value={promisedDemo}
                onChange={(event) => {
                  setPromisedDemo(event.target.value);
                  renewFounderBookingRequest();
                }}
                maxLength={500}
                rows={3}
                placeholder="What will the founder review or demonstrate on the call?"
                className={`${INPUT} mt-1.5`}
              />
              <span className="mt-1 block text-[10px] font-normal text-fg-dim">
                This is safe for the client to see and is included in the Calendar invite.
              </span>
            </label>

            <div className="rounded-xl border border-bg-border/70 bg-bg-elev/20 p-3">
              <div className="text-xs font-semibold text-fg">Internal founder handoff note</div>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-fg-muted">
                {transitionNote.trim() || "Add the client needs, objections, timing, and sales context in the note above."}
              </p>
              <div className="mt-2 text-[10px] text-fg-dim">
                This is visible to your team and never sent to the client.
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-3">
              <ConfirmationCheckCard
                checked={effectiveContactConfirmed}
                onChange={setContactConfirmed}
                label={
                  <>
                    I confirmed the client&apos;s contact details and email.
                  </>
                }
              />
              <ConfirmationCheckCard
                checked={effectiveClientAgreedToTime}
                onChange={setClientAgreedToTime}
                label={<>The client agreed to this date and time.</>}
              />
              <ConfirmationCheckCard
                checked={effectiveHandoffComplete}
                disabled={!transitionNote.trim()}
                onChange={setHandoffComplete}
                label={<>The internal founder handoff note is complete.</>}
              />
            </div>

            {bookingContact.phone.trim() ? (
              <ConfirmationCheckCard
                checked={smsConsent}
                onChange={(checked) => {
                  setSmsConsent(checked);
                  renewFounderBookingRequest();
                }}
                label={
                  <>
                    Client consented to SMS meeting reminders at {bookingContact.phone.trim()} (optional;
                    used only when SMS delivery is enabled).
                  </>
                }
              />
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-bg-border/70 pt-4">
              <div className="text-[11px] leading-5 font-medium">
                {bookingBlockedReason ? (
                  <span className="text-amber-200">Required to book: {bookingBlockedReason}</span>
                ) : (
                  <span className="text-emerald-300">✓ All details confirmed — ready to book meeting & send client invite</span>
                )}
              </div>
              <button
                type="button"
                disabled={disabled || !founderBookingReady}
                onClick={() => void bookFounderMeeting()}
                className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-sm"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {"Book meeting & send invite"}
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
                  onChange={(event) => {
                    setDealOutcome(event.target.value as "follow_up" | "no_show" | "reschedule" | "lost");
                    setOutcomeConfirmed(false);
                    renewDealOutcomeRequest();
                  }}
                  className={`${INPUT} mt-1.5`}
                >
                  <option value="follow_up">Follow-up required</option>
                  <option value="no_show">Client no-show</option>
                  <option value="reschedule">Rescheduled</option>
                  <option value="lost">Closed lost</option>
                </select>
              </label>
              {dealOutcome !== "lost" ? (
                <LifecycleDateTimeFields
                  label={dealOutcome === "reschedule" ? "New meeting" : "Next follow-up"}
                  date={nextActionDate}
                  time={nextActionTime}
                  onDateChange={updateNextActionDate}
                  onTimeChange={updateNextActionTime}
                />
              ) : (
                <label className="text-xs text-fg-muted">
                  Loss reason
                  <input
                    value={lossReason}
                    onChange={(event) => {
                      setLossReason(event.target.value);
                      setOutcomeConfirmed(false);
                      renewDealOutcomeRequest();
                    }}
                    maxLength={500}
                    className={`${INPUT} mt-1.5`}
                  />
                </label>
              )}
            </div>
            {dealOutcome === "reschedule" ? (
              <div className="rounded-lg border border-accent/25 bg-accent/5 px-3 py-2 text-xs leading-5 text-fg-muted">
                Rescheduling updates the existing Google invite, preserves its Meet link, and replaces the old
                reminder time after Google verifies the change.
              </div>
            ) : null}
            <label className="flex items-start gap-2 rounded-lg border border-bg-border/70 bg-bg-elev/30 px-3 py-2.5 text-xs leading-5 text-fg-muted">
              <input
                type="checkbox"
                checked={outcomeConfirmed}
                onChange={(event) => setOutcomeConfirmed(event.target.checked)}
                className="mt-1"
              />
              {dealOutcome === "lost"
                ? "I confirmed the loss reason and understand any active future invite will be cancelled while completed meeting history stays intact."
                : dealOutcome === "reschedule"
                  ? "I confirmed this new date and time with the client."
                  : dealOutcome === "no_show"
                    ? "I confirmed the client did not attend and the old meeting reminders should stop."
                    : "I confirmed the follow-up time and recorded the necessary context in the note above."}
            </label>
            <button
              type="button"
              disabled={
                disabled ||
                !outcomeConfirmed ||
                (dealOutcome === "lost" ? !lossReason.trim() : !nextActionAt || !transitionNote.trim())
              }
              onClick={() => void recordDealOutcome()}
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
              ? "This lead is closed as lost. An admin can reopen it from the stage dropdown above."
              : "Lifecycle complete. The client has launched."}
          </div>
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

function CheckSquare({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition ${
        checked
          ? "border-emerald-400/80 bg-emerald-400/90 text-bg-deep"
          : "border-bg-border bg-bg-deep text-transparent"
      }`}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </span>
  );
}

/** A qualification gate rendered as a compact toggle card with an emerald active state. */
function QualificationGateCard({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
        checked
          ? "border-emerald-500/50 bg-emerald-500/10 text-fg"
          : "border-bg-border bg-bg-elev/30 text-fg-muted hover:border-accent/40 hover:text-fg"
      }`}
    >
      <CheckSquare checked={checked} />
      {label}
    </button>
  );
}

/** A booking confirmation item as a toggle card; keeps the exact confirmation wording. */
function ConfirmationCheckCard({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left text-xs leading-5 transition disabled:cursor-not-allowed disabled:opacity-60 ${
        checked
          ? "border-emerald-500/50 bg-emerald-500/10 text-fg"
          : "border-bg-border bg-bg-elev/30 text-fg-muted hover:border-accent/40 hover:text-fg"
      }`}
    >
      <span className="mt-0.5">
        <CheckSquare checked={checked} />
      </span>
      <span>{label}</span>
    </button>
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
    client_email_required: "Enter a valid client email so Google can deliver the invitation.",
    invalid_client_phone: "Enter a valid phone number or leave it blank.",
    invalid_client_website: "Enter a valid website address or leave it blank.",
    handoff_note_required: "Complete the internal founder handoff note.",
    booking_confirmations_required: "Confirm the client contact, agreed time, and internal handoff before booking.",
    outcome_confirmation_required: "Confirm the selected outcome before saving it.",
    sms_consent_requires_phone: "Add a valid client phone number before recording SMS consent.",
    google_calendar_not_connected: "The selected host must connect their work Google account in Settings.",
    calendar_scope_required: "The selected host must reconnect Google once to approve Calendar access.",
    // ADDED 2026-08-26. These five are declared in GoogleCalendarErrorCode
    // (lib/integrations/google-calendar.ts) and every one of them was missing
    // here, so the RAW CODE reached the rep's screen. The operator reported it
    // as "it says invalid token or something" -- that was `token_refresh_failed`
    // falling straight through this map onto a sales rep mid-handoff.
    //
    // A rep cannot act on a code. Each message below names the human step,
    // because every one of these is a "somebody must go and do a thing"
    // condition, not something retrying will clear.
    token_refresh_failed:
      "Google rejected the host's saved sign-in, usually because access was revoked or the password changed. " +
      "They need to reconnect Google once in Settings. Nothing was booked and no invite went out.",
    google_oauth_config_missing:
      "This deployment is missing its Google OAuth configuration, so no host can book. Nothing was booked. Tell an administrator.",
    calendar_reconcile_failed:
      "Google accepted the booking but we could not read it back to confirm it. Do not rebook yet: check the host's calendar first, then retry.",
    calendar_read_failed:
      "Google Calendar could not be read just now. Nothing was changed. Retry in a moment.",
    invalid_request:
      "Google rejected the booking details. Check the meeting time, the client email, and the host, then retry.",
    calendar_organizer_mismatch: "The selected host connected a different Google account. Reconnect with their OASIS work email before booking.",
    google_meet_link_missing: "Google created the event but has not returned its Meet link yet. Retry this booking; it will reconcile the same event.",
    calendar_create_failed: "Google Calendar could not verify this booking. Nothing moved; retry after checking the host connection.",
    calendar_update_failed: "Google Calendar could not verify the new time, so the lead was not changed. Check the host connection and retry.",
    calendar_cancel_failed: "The deal outcome was saved, but Google could not finish the invitation cleanup. Retry the same action; the background worker will also reconcile it.",
    verified_meeting_required: "This older booking has no verified Calendar receipt. Return it to Qualified and book it through the guided handoff.",
    meeting_no_longer_reschedulable: "This meeting is already completed or cancelled and cannot be rescheduled.",
    meeting_transition_pending: "A Calendar change is already waiting for its lifecycle update. Refresh and retry the same action.",
    outcome_note_required: "Add the outcome and handoff context in the note above before saving.",
    meeting_close_failed: "The meeting outcome could not close its reminder queue. Refresh and retry before moving on.",
    meeting_not_started: "A no-show cannot be recorded before the scheduled meeting time.",
    booking_request_mismatch: "This booking request changed after it was submitted. Refresh and create a new booking request.",
    verified_meeting_receipt_missing: "The saved lifecycle event is missing its Google receipt. Ask an admin to review it.",
    meeting_activation_failed: "The meeting exists, but its reminder queue needs to be reactivated. Retry the same booking.",
    transition_note_required: "Explain the reason before applying an admin stage correction.",
    use_structured_lifecycle_action: "Use the structured action for this phase.",
    rep_stage_forbidden: "Only an admin can move a lead directly between stages.",
    invalid_stage: "That stage is not part of the OASIS pipeline.",
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

function BookingContactField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel" | "url";
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`text-xs text-fg-muted ${className}`}>
      <span className="flex items-baseline gap-1">
        {label}
        {required ? (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/90">
            Required
          </span>
        ) : null}
      </span>
      <input
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`${INPUT} mt-1.5`}
      />
    </label>
  );
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
