/**
 * next-steps-email.ts — the SunBiz funnel hand-off automations.
 *
 * Two transactional emails, sent from the connected SunBiz mailbox, signed by
 * the agent the lead is assigned to:
 *   - maybeSendNextStepsEmail        → after the interest form (step 1): ONE link
 *                                       to the full application (step 2).
 *   - maybeSendApplicationCompleteEmail → legacy fallback for old full-application
 *                                       forms that did not collect statements
 *                                       in-flow. Current SunBiz templates collect
 *                                       docs inside the full application.
 *
 * Why a NEW path instead of the old resume-email queue:
 * The form-submit route used to queue a `lead_interactions` row
 * (agent_source='form_intake_resume', type='email_queued') and rely on a
 * daemon to send it. But the dashboard-email-consumer daemon ONLY drains
 * agent_source='dashboard_drawer' rows — so even now that it runs on the VPS
 * (moved off Windows-only 2026-06-29), form_intake_resume rows aren't its job
 * and would sit at status='queued' forever — never sent.
 * (Verified 2026-06-17: 5/5 form_intake_resume rows stuck queued, 0 sent.)
 *
 * The proven path is the SAME one the lead-drawer email uses (27/27 sent):
 * the bridge `send_email` tool → send_gateway → SMTP from the tenant mailbox.
 * The form-submit route is PUBLIC (HMAC token, no session), so we resolve the
 * bridge target server-side (resolveBridgeTarget) and call the raw bridge with
 * the server-held bearer. The payload is fully server-templated (no
 * user-controlled command), so this is a trusted server-to-server send.
 *
 * intent='transactional': a direct response to the prospect's own submission,
 * so it bypasses the cold-outreach hygiene gates but still applies the CASL
 * footer + unsubscribe headers inside send_gateway. Because transactional
 * BYPASSES send_gateway's suppression gate, every sender below re-checks
 * email_suppressions FAIL-CLOSED before the address reaches the bridge.
 *
 * Idempotent per lead PER VARIANT PER RESEND WINDOW (24h). The original
 * "one per lead per lifetime" rule silently starved re-engaging merchants:
 * a lead who got their first next-steps email in June and re-submitted the
 * interest form in August was suppressed forever (26 such leads found
 * 2026-08-18 — ~27% of post-cutover Form 1 completions produced no email and
 * no record of why). A NEW submission outside the window is a merchant asking
 * to re-enter the funnel and re-sends a fresh personalized link; duplicate
 * protection within the window still holds, atomically, via the
 * window-bucketed reservation key below.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBridgeTarget, callBridgeExecTool } from "@/lib/bridge-proxy";
import { getAgents } from "@/lib/config/agents";
import { getTenantMembers } from "@/lib/team";
import { mintFormLinkBySlug } from "@/lib/forms/agent-routing";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { getSubmissionsCreds } from "@/lib/integrations/submissions-gmail";
import type { BrandKey } from "@/lib/email/brands";
import { SUNBIZ_LEGAL_FOOTER } from "@/lib/config/email-signature";
import { listUnsubscribeHeader } from "@/lib/email/tracked-html";
import { isUniqueViolationError } from "@/lib/api-helpers";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * How long a prior send (or failure marker) of the same variant suppresses a
 * re-send. Within the window a duplicate submission is a double-click or a
 * refresh; outside it, it is a merchant re-entering the funnel who needs the
 * link again. Also the bucket size of the reservation key, so the atomic
 * concurrent-duplicate guard and this read-side gate agree.
 */
const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** agent_source tags — distinct per variant so the FAILURE-path marker + the
 *  idempotency check are clean and don't collide across the two emails. */
const NEXT_STEPS_SOURCE = "form_intake_next_steps";
const APP_COMPLETE_SOURCE = "form_intake_app_complete";
const APPLICATION_RECEIVED_SOURCE = "form_intake_application_received";

export type MaybeSendNextStepsInput = {
  db: SupabaseClient;
  /** Already-fetched form row. */
  form: { id: string; tenant_id: string; slug: string };
  /** Verified form-link payload (tenant slug, lead_id). */
  link: { tenant: string; lead_id: string };
  /** The just-submitted step's payload (for the email fallback). */
  payload: Record<string, unknown>;
  /** Request origin, for building absolute links. */
  origin: string;
};

type SignerCtx = { name: string; email: string; phone: string };

/**
 * Resolve the bridge target for the tenant + fire the send_email tool. Returns
 * a discriminated result so the caller can record send vs queued-fallback.
 * Best-effort: any failure returns {sent:false, reason} and the caller logs a
 * recoverable interaction the operator can see.
 */
async function sendViaBridge(input: {
  db: SupabaseClient;
  source: string;
  tenantId: string;
  tenant: { slug: string; custom_fields: Record<string, unknown> | null };
  to: string;
  subject: string;
  body: string;
  brand?: BrandKey;
  leadId: string;
  signer: SignerCtx;
  /** Assigned-agent email to CC (so the rep whose form it was gets a copy). */
  cc?: string | null;
  recoveryAttempt?: boolean;
}): Promise<{ sent: boolean; reason?: string }> {
  // Primary path: send directly from the tenant's encrypted Gmail App Password.
  // This keeps public-form confirmations on the same mailbox used by shop-out
  // and avoids depending on the separate bridge/daemon being online.
  // This direct footer is deliberately SunBiz-only. Other brands retain the
  // bridge path until their own legal/footer renderer is wired here.
  if (input.brand === "sunbiz") {
    // Atomic reservation on the existing provider/message unique index. This
    // closes the race where two simultaneous final-step posts both pass the
    // read-based alreadySent check before either reaches SMTP. The key is
    // bucketed by RESEND_WINDOW so a genuinely new submission in a later
    // window mints a new key and can send again, while concurrent duplicates
    // inside one window still collide on the index.
    const windowBucket = Math.floor(Date.now() / RESEND_WINDOW_MS);
    const reservationKey = `${input.leadId}:${input.source}:${windowBucket}`;
    const reservation = await input.db.from("lead_interactions").insert({
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      type: "email_queued",
      channel: "email",
      direction: "outbound",
      agent_source: "form_send_reservation",
      provider: "form_transactional",
      provider_message_id: reservationKey,
      subject: input.subject.slice(0, 200),
      content: input.body,
      content_preview: input.body.slice(0, 1024),
      to_email: input.to,
      metadata: { status: "sending", intended_source: input.source },
    }).select("id").single();

    // isUniqueViolationError, not `code === "23505"`. This is the idempotency
    // CLAIM: a duplicate reservation key means the email already went out, and
    // this branch returns { sent: true } rather than sending it twice. On Turso
    // the adapter reports a unique violation as code "TURSO_ADAPTER" with the
    // detail only in the message, so the Postgres-only check never fired and
    // the guard against double-sending a transactional email to a lead was dead.
    if (isUniqueViolationError(reservation.error)) {
      const existing = await input.db.from("lead_interactions")
        .select("id, created_at, metadata")
        .eq("provider", "form_transactional")
        .eq("provider_message_id", reservationKey)
        .eq("tenant_id", input.tenantId)
        .maybeSingle();
      const row = existing.data as {
        id?: string;
        created_at?: string;
        metadata?: { status?: string } | null;
      } | null;
      const ageMs = row?.created_at ? Date.now() - new Date(row.created_at).getTime() : 0;
      if (
        !input.recoveryAttempt &&
        row?.id &&
        row.metadata?.status === "sending" &&
        ageMs > 5 * 60 * 1000
      ) {
        // Conditional on metadata->>status, NOT the object-containment filter:
        // on the Turso adapter containment compiles to json_each ARRAY
        // semantics and never matches an object column (verified live
        // 2026-08-18), which made this release a silent no-op — a crashed
        // worker's reservation was permanent and the merchant's email
        // unrecoverable. The JSON-path filter compiles to json_extract and
        // actually fires.
        const released = await input.db.from("lead_interactions")
          .delete()
          .eq("id", row.id)
          .eq("tenant_id", input.tenantId)
          .eq("metadata->>status", "sending")
          .select("id");
        if (!released.error && (released.data?.length ?? 0) === 1) {
          return sendViaBridge({ ...input, recoveryAttempt: true });
        }
      }
      return { sent: true };
    }
    if (!reservation.error && reservation.data?.id) {
      // Deterministic-winner check (Codex review P2, 2026-08-18): two
      // concurrent submissions can straddle a window-bucket boundary and win
      // DIFFERENT reservation keys, so the unique index alone can't dedupe
      // them. Fetch every form_transactional row for this lead+source inside
      // the window; the earliest (created_at, id) owns the send. Both racers
      // compute the same winner, so exactly one proceeds and the loser
      // releases its reservation and defers.
      const windowStartIso = new Date(Date.now() - RESEND_WINDOW_MS).toISOString();
      const rivals = await input.db.from("lead_interactions")
        .select("id, created_at")
        .eq("tenant_id", input.tenantId)
        .eq("lead_id", input.leadId)
        .eq("provider", "form_transactional")
        .like("provider_message_id", `${input.leadId}:${input.source}:%`)
        .gte("created_at", windowStartIso)
        .limit(10);
      if (rivals.error) {
        // Can't prove we're the winner — release and fail toward the marker
        // path rather than risk a duplicate transactional send.
        await input.db.from("lead_interactions").delete()
          .eq("id", reservation.data.id).eq("tenant_id", input.tenantId);
        return { sent: false, reason: "reservation_winner_check_failed" };
      }
      const rows = (rivals.data ?? []) as Array<{ id: string; created_at: string | null }>;
      const winner = rows.slice().sort((a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id))[0];
      if (winner && winner.id !== reservation.data.id) {
        await input.db.from("lead_interactions").delete()
          .eq("id", reservation.data.id).eq("tenant_id", input.tenantId);
        return { sent: true }; // the earlier row owns this window's send
      }
      const direct = await sendGmail({
        tenantId: input.tenantId,
        brand: "sunbiz",
        to: input.to,
        cc: input.cc ? [input.cc] : undefined,
        subject: input.subject,
        body: input.body.replace(/\s+$/, "") + SUNBIZ_LEGAL_FOOTER,
        listUnsubscribe: listUnsubscribeHeader(input.to, "SunBiz"),
        retryTransient: false,
      });
      if (direct.ok) {
    // The bridge normally writes this canonical audit/idempotency row. Direct
        // SMTP must turn its reservation into that same audit/idempotency row.
        const recorded = await input.db.from("lead_interactions").update({
          type: "email_sent",
          agent_source: input.source,
          metadata: {
            status: "sent",
            sent_at: new Date().toISOString(),
            sent_via: "submissions_gmail_apppassword",
            cc_email: input.cc || null,
            gmail_message_id: direct.message_id,
            intent: "transactional",
          },
        }).eq("id", reservation.data.id).eq("tenant_id", input.tenantId);
        if (recorded.error) {
          console.error("[forms.handoff] direct send audit write failed", {
            lead_id: input.leadId,
            source: input.source,
            error: recorded.error.message,
          });
        }
        return { sent: true };
      }
      // Release only this unsent temporary reservation so the established
      // bridge fallback can make its own idempotent attempt.
      await input.db.from("lead_interactions")
        .delete()
        .eq("id", reservation.data.id)
        .eq("tenant_id", input.tenantId);
    } else if (reservation.error) {
      console.error("[forms.handoff] direct send reservation failed", {
        lead_id: input.leadId,
        source: input.source,
        error: reservation.error.message,
      });
    }
  }

  const target = resolveBridgeTarget(input.tenant);
  if (!target) return { sent: false, reason: "bridge_not_configured" };

  // Mirror the lead-drawer send_email payload shape EXACTLY (proven path):
  // send_email params are top-level siblings of tool_name, not nested. The
  // bridge send_email tool runs `cc` through send_gateway.normalize_cc (header-
  // injection validated), so the CC value is forwarded safely.
  const toolBody: Record<string, unknown> = {
    tool_name: "send_email",
    to: input.to,
    subject: input.subject,
    body: input.body,
    lead_id: input.leadId,
    brand: input.brand,
    intent: "transactional",
    signer_name: input.signer.name,
  };
  if (input.signer.email) toolBody.signer_email = input.signer.email;
  if (input.signer.phone) toolBody.signer_phone = input.signer.phone;
  if (input.cc) toolBody.cc = input.cc;

  const r = await callBridgeExecTool(target, toolBody);
  if (!r.ok) {
    return { sent: false, reason: (r.error || r.output || `bridge_http_${r.httpStatus}`).slice(0, 200) };
  }
  // send_gateway returns its --json blob in `output`; status:"sent" means the
  // gates walked AND SMTP fired.
  try {
    const parsed = JSON.parse(r.output || "{}") as { status?: string; reason?: string };
    if (parsed.status === "sent") return { sent: true };
    return { sent: false, reason: `send_gateway status=${parsed.status || "unknown"}: ${parsed.reason || ""}`.slice(0, 200) };
  } catch {
    return { sent: false, reason: "bridge returned non-JSON output" };
  }
}

type AssignedAgent = SignerCtx & {
  /** Email to CC — non-null ONLY when authoritatively resolved from assigned_to.
   *  Never derived from the cached name, so we can't CC a stale/wrong rep. */
  ccEmail: string | null;
};

/**
 * Resolve the assigned agent for both the signature AND the CC, from the lead.
 *
 * `assigned_to` (auth_user_id) is AUTHORITATIVE. We resolve the tenant member by
 * it and use their real name + email. We deliberately do NOT use the cached
 * `assigned_agent_name` as a resolution source: the reassignment endpoint
 * updates assigned_to but leaves assigned_agent_name stale, so trusting the name
 * could CC the PREVIOUS rep and leak merchant details to the wrong internal
 * recipient. (Codex audit 2026-06-18 [high].)
 */
async function resolveAssignedAgent(
  tenantId: string,
  assignedTo: string | null,
  fallbackName: string,
): Promise<AssignedAgent> {
  const safeName = (fallbackName || "").trim() || "the SunBiz team";
  if (assignedTo) {
    try {
      const members = await getTenantMembers(tenantId);
      const member = members.find((x) => x.auth_user_id === assignedTo);
      const email = (member?.email || "").trim();
      if (email) {
        const name = (member?.display_name || member?.full_name || "").trim() || safeName;
        // Phone isn't on the member row — pull it from the signing roster by
        // EMAIL match (member email is the canonical address). Best-effort.
        let phone = "";
        try {
          const roster = getAgents();
          const r = roster.find((a) => a.email.trim().toLowerCase() === email.toLowerCase());
          if (r) phone = r.phone;
        } catch {
          /* roster read failed — phone stays blank, non-fatal */
        }
        return { name, email, phone, ccEmail: email };
      }
    } catch {
      // member lookup failed — fall through to name-only signer + no CC.
    }
  }
  // Unassigned / unresolvable: display name only, never a guessed CC.
  return { name: safeName, email: "", phone: "", ccEmail: null };
}

/** Subject prefixes per variant — used both as the literal subject base and to
 *  detect send_gateway's CANONICAL success row (whose agent_source is the
 *  gateway default 'manual_cc', not our source) for idempotency. Keep these
 *  lowercase + distinct; an inbound reply ("Re: …") never starts with them. */
const NEXT_STEPS_SUBJECT_PREFIX = "your next steps with ";
const APP_COMPLETE_SUBJECT_PREFIX = "we've received your application";
const APPLICATION_RECEIVED_SUBJECT_PREFIX = "application received";

/**
 * Has an email of THIS variant already been recorded for this lead? One per lead
 * per variant. Two row shapes can mark a prior send (send_gateway ALWAYS logs
 * its own 'manual_cc' canonical row on success; this module logs its own row on
 * the FAILURE path): match either our `source` row or the gateway's success row
 * by the variant's subject prefix. (See the 2026-06-18 duplicate-timeline fix —
 * we no longer insert our own success row.)
 *
 * NB: deliberately NOT filtered on direction='outbound' — no send_gateway write
 * path explicitly stamps direction, so a filter could miss the success row and
 * let a re-submit re-send. channel='email' + the distinctive subject prefix is
 * enough.
 */
/**
 * Three outcomes, deliberately NOT a boolean.
 *
 * `skipped_already_sent` and `skipped_check_failed` both stop the send, but they
 * are not the same event and must not look the same to an operator. The first is
 * the system working (one email per lead per variant). The second is a merchant
 * who will never receive their receipt, and for a COMPLETED application there is
 * no later submit to retry on — so if it is not recorded, it is simply lost.
 * Collapsing them into `true` made a dropped receipt indistinguishable from a
 * correctly-suppressed duplicate, visible only in a console line nobody reads.
 * See [[feedback_redundancy_hides_failure]].
 */
type SendGate = "send" | "skipped_already_sent" | "skipped_check_failed";

async function alreadySent(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
  source: string,
  subjectPrefix: string,
): Promise<SendGate> {
  // Only rows inside the resend window suppress. An unbounded lookback froze
  // out every merchant whose FIRST funnel email predated their current
  // submission (including matches via the subject-prefix arm against old
  // send_gateway 'manual_cc' rows) — the send became once per lifetime instead
  // of once per submission burst.
  const windowStart = new Date(Date.now() - RESEND_WINDOW_MS).toISOString();
  const res = await db
    .from("lead_interactions")
    .select("agent_source, subject")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("channel", "email")
    .gte("created_at", windowStart)
    .limit(50);
  if (res.error) {
    console.error("[forms.handoff] idempotency check failed - skipping send (fail-closed)", {
      lead_id: leadId,
      source,
      error: res.error.message,
    });
    return "skipped_check_failed";
  }
  const hit = (res.data ?? []).some(
    (r) =>
      r.agent_source !== "form_send_reservation" &&
      (r.agent_source === source ||
        (typeof r.subject === "string" &&
          r.subject.trim().toLowerCase().startsWith(subjectPrefix))),
  );
  return hit ? "skipped_already_sent" : "send";
}

/**
 * Record a receipt that was suppressed because we could not PROVE it had not
 * already gone out. Best-effort by necessity: the read that failed and this
 * write share a backend, so this can fail too — but a row that lands turns an
 * invisible drop into a `status: "failed"` entry on the lead's timeline, in the
 * same place every other send failure appears.
 *
 * Stamped with `agent_source: source` like every other failure marker here, so
 * it also suppresses a duplicate on any subsequent attempt. The subject is
 * deliberately NOT the variant's real subject — it must never satisfy the
 * subject-prefix arm of the idempotency check for a DIFFERENT variant.
 */
async function logIdempotencyCheckFailure(
  db: SupabaseClient,
  form: { tenant_id: string },
  leadId: string,
  source: string,
  toEmail: string,
  ccEmail: string | null,
): Promise<void> {
  try {
    await db.from("lead_interactions").insert({
      tenant_id: form.tenant_id,
      lead_id: leadId,
      type: "email_queued",
      channel: "email",
      direction: "outbound",
      agent_source: source,
      subject: `(not sent) ${source} - could not verify prior send`,
      content: "",
      content_preview: "",
      to_email: toEmail,
      metadata: {
        status: "failed",
        sent_at: null,
        send_error: "idempotency_check_failed",
        cc_email: ccEmail,
        intent: "transactional",
        needs_operator_review: true,
      },
    });
  } catch (err) {
    console.error("[forms.handoff] could not record the suppressed send", {
      lead_id: leadId,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Resolved recipient + tenant + signer context shared by both senders. */
type HandoffContext = {
  toEmail: string;
  toName: string | null;
  tenant: { slug: string; custom_fields: Record<string, unknown> | null };
  brandLabel: string;
  brandSlug: BrandKey | undefined;
  signer: SignerCtx;
  ccEmail: string | null;
};

/**
 * Resolve the lead's contact email (+ name), enforce the fail-closed suppression
 * re-check, and resolve the tenant brand + the assigned agent (signer + CC).
 * Returns null when there's nothing safe/usable to send (no email, suppressed,
 * lookup error, or missing tenant) — the caller then no-ops. Shared by both
 * variants so the security posture (fail-closed suppression, authoritative
 * assigned-agent CC) is identical and lives in ONE place.
 */
async function loadHandoffContext(
  db: SupabaseClient,
  form: { id: string; tenant_id: string },
  link: { lead_id: string },
  payload: Record<string, unknown>,
): Promise<HandoffContext | null> {
  const leadRow = await db
    .from("tenant_records")
    .select("data")
    .eq("id", link.lead_id)
    .eq("tenant_id", form.tenant_id)
    .maybeSingle();
  const leadData =
    (leadRow.data as { data: Record<string, unknown> | null } | null)?.data ?? {};

  const toEmailRaw =
    (typeof leadData.email === "string" && leadData.email) ||
    (typeof payload.email === "string" && payload.email) ||
    "";
  const toEmail = toEmailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(toEmail)) return null; // no usable email — nothing to send

  // Honor unsubscribes even though this send is transactional (which bypasses
  // send_gateway's own suppression gate). FAIL CLOSED: any lookup error → do not
  // send. (Codex audit 2026-06-17 [high]: public relay must not fail open.)
  // Escape LIKE wildcards — `_`/`%` are valid in an email local-part.
  const suppPattern = toEmail.replace(/[%_\\]/g, "\\$&");
  const supp = await db
    .from("email_suppressions")
    .select("email")
    .eq("tenant_id", form.tenant_id)
    .ilike("email", suppPattern)
    .limit(1);
  if (supp.error) {
    console.error("[forms.handoff] suppression check errored — skipping (fail-closed)", {
      lead_id: link.lead_id,
      error: supp.error.message,
    });
    return null;
  }
  if ((supp.data?.length ?? 0) > 0) {
    console.log("[forms.handoff] recipient suppressed — skipping", { lead_id: link.lead_id });
    return null;
  }

  const tenantRow = await db
    .from("tenants")
    .select("slug, name, custom_fields")
    .eq("id", form.tenant_id)
    .maybeSingle();
  const tenant = tenantRow.data as
    | { slug: string; name: string | null; custom_fields: Record<string, unknown> | null }
    | null;
  if (!tenant) return null;
  const brandFromCustom =
    typeof tenant.custom_fields?.brand === "string" ? (tenant.custom_fields.brand as string) : null;
  const brandLabel = brandFromCustom || tenant.name || "SunBiz Funding";
  // send_gateway's `brand` key is the routing slug (sunbiz / oasis), not the label.
  const brandSlug: BrandKey | undefined = tenant.slug === "submissions"
    ? "sunbiz"
    : tenant.slug === "bluerise"
      ? "bluerise"
      : undefined;

  const toName =
    (typeof leadData.contact_name === "string" && leadData.contact_name) ||
    (typeof leadData.name === "string" && leadData.name) ||
    (typeof payload.contact_name === "string" && payload.contact_name) ||
    (typeof payload.name === "string" && payload.name) ||
    null;
  const assignedTo = typeof leadData.assigned_to === "string" ? leadData.assigned_to : null;
  const fallbackName =
    (typeof leadData.assigned_agent_name === "string" && leadData.assigned_agent_name) ||
    "the SunBiz team";
  const agent = await resolveAssignedAgent(form.tenant_id, assignedTo, fallbackName);

  // CC routing: the authoritatively-resolved assigned agent, else the
  // submissions inbox — an unassigned lead's funnel email must still land in
  // front of a human. The address comes from the same encrypted credential
  // store the send authenticates with (never a guessed/hardcoded mailbox);
  // if it can't be resolved the CC stays null and the send proceeds.
  let ccEmail = agent.ccEmail;
  if (!ccEmail && brandSlug === "sunbiz") {
    try {
      const creds = await getSubmissionsCreds(form.tenant_id, "sunbiz");
      ccEmail = (creds.fromAddress || "").trim() || null;
    } catch {
      ccEmail = null;
    }
  }

  return {
    toEmail,
    toName,
    tenant: { slug: tenant.slug, custom_fields: tenant.custom_fields },
    brandLabel,
    brandSlug,
    signer: { name: agent.name, email: agent.email, phone: agent.phone },
    ccEmail,
  };
}

/** Log the FAILURE-path marker (operator can see + resend). On SUCCESS we never
 *  insert — send_gateway logs its own canonical row (avoids the duplicate
 *  timeline entry CC reported 2026-06-18). */
async function logFailureMarker(
  db: SupabaseClient,
  form: { tenant_id: string },
  leadId: string,
  source: string,
  subject: string,
  body: string,
  toEmail: string,
  ccEmail: string | null,
  reason: string | undefined,
  extraMeta: Record<string, unknown>,
): Promise<void> {
  await db.from("lead_interactions").insert({
    tenant_id: form.tenant_id,
    lead_id: leadId,
    type: "email_queued",
    channel: "email",
    direction: "outbound",
    agent_source: source,
    subject: subject.slice(0, 200),
    content: body,
    content_preview: body.slice(0, 1024),
    to_email: toEmail,
    metadata: { status: "failed", sent_at: null, send_error: reason || "unknown", cc_email: ccEmail, intent: "transactional", ...extraMeta },
  });
}

/**
 * STEP 1 → STEP 2 hand-off: email the merchant ONE link to the full application
 * after they complete the interest form. Soft-fail; idempotent per lead.
 */
export async function maybeSendNextStepsEmail(input: MaybeSendNextStepsInput): Promise<void> {
  try {
    const { db, form, link, payload, origin } = input;
    const ctx = await loadHandoffContext(db, form, link, payload);
    if (!ctx) return;
    const nextStepsGate = await alreadySent(
      db, form.tenant_id, link.lead_id, NEXT_STEPS_SOURCE, NEXT_STEPS_SUBJECT_PREFIX,
    );
    if (nextStepsGate === "skipped_check_failed") {
      await logIdempotencyCheckFailure(
        db, form, link.lead_id, NEXT_STEPS_SOURCE, ctx.toEmail, ctx.ccEmail,
      );
      return;
    }
    if (nextStepsGate === "skipped_already_sent") return;

    // CC 2026-06-22: form 1 points to form 2 ONLY (sequential funnel). The
    // bank-statement link is sent later, by maybeSendApplicationCompleteEmail.
    const fullAppUrl = await mintFormLinkBySlug(
      origin, form.tenant_id, link.tenant, link.lead_id, "full-application",
    );
    if (!fullAppUrl) {
      console.error("[forms.next_steps] full-application link did not resolve — skipping", { lead_id: link.lead_id });
      return;
    }

    const greeting = ctx.toName && ctx.toName.trim() ? `Hi ${ctx.toName.trim().split(/\s+/)[0]},` : "Hi there,";
    const subject = `Your next steps with ${ctx.brandLabel}`;
    const body = [
      greeting,
      "",
      `Thanks for reaching out to ${ctx.brandLabel}. The next step is your application — it takes about 5 minutes:`,
      "",
      "Complete your application:",
      fullAppUrl,
      "",
      "Your link is personalized to you — anything you've already told us is saved.",
      "",
      "Reply to this email if you have any questions and I'll help you through it.",
      "",
      `— ${ctx.signer.name}`,
      ctx.brandLabel,
    ].join("\n");

    const result = await sendViaBridge({
      db,
      source: NEXT_STEPS_SOURCE,
      tenantId: form.tenant_id,
      tenant: ctx.tenant, to: ctx.toEmail, subject, body, brand: ctx.brandSlug,
      leadId: link.lead_id, signer: ctx.signer, cc: ctx.ccEmail,
    });
    if (!result.sent) {
      await logFailureMarker(db, form, link.lead_id, NEXT_STEPS_SOURCE, subject, body, ctx.toEmail, ctx.ccEmail, result.reason, {
        next_steps: true, full_application_url: fullAppUrl,
      });
      console.error("[forms.next_steps] send did not fire", { lead_id: link.lead_id, reason: result.reason });
    }
  } catch (err) {
    console.error("[forms.next_steps] threw", {
      lead_id: input.link.lead_id, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Legacy STEP 2 → STEP 3 follow-through: old full-application forms lacked an
 * in-flow upload step, so completion emailed one link to the bank-statement
 * upload. Current full-application templates collect documents in-flow and the
 * submit route skips this sender for those forms.
 */
export async function maybeSendApplicationCompleteEmail(input: MaybeSendNextStepsInput): Promise<void> {
  try {
    const { db, form, link, payload, origin } = input;
    const ctx = await loadHandoffContext(db, form, link, payload);
    if (!ctx) return;
    const appCompleteGate = await alreadySent(
      db, form.tenant_id, link.lead_id, APP_COMPLETE_SOURCE, APP_COMPLETE_SUBJECT_PREFIX,
    );
    if (appCompleteGate === "skipped_check_failed") {
      await logIdempotencyCheckFailure(
        db, form, link.lead_id, APP_COMPLETE_SOURCE, ctx.toEmail, ctx.ccEmail,
      );
      return;
    }
    if (appCompleteGate === "skipped_already_sent") return;

    const bankUrl = await mintFormLinkBySlug(
      origin, form.tenant_id, link.tenant, link.lead_id, "bank-statement-upload",
    );
    if (!bankUrl) {
      console.error("[forms.app_complete] bank-statement link did not resolve — skipping", { lead_id: link.lead_id });
      return;
    }

    const greeting = ctx.toName && ctx.toName.trim() ? `Hi ${ctx.toName.trim().split(/\s+/)[0]},` : "Hi there,";
    const subject = `We've received your application — ${ctx.brandLabel}`;
    const body = [
      greeting,
      "",
      `Thanks — we've received your application with ${ctx.brandLabel}. There's one last step to start your funding review:`,
      "",
      "Upload your last few months of business bank statements:",
      bankUrl,
      "",
      "As soon as your statements are in, we begin reviewing right away. Your link is personalized to you.",
      "",
      "Reply to this email with any questions and I'll help you through it.",
      "",
      `— ${ctx.signer.name}`,
      ctx.brandLabel,
    ].join("\n");

    const result = await sendViaBridge({
      db,
      source: APP_COMPLETE_SOURCE,
      tenantId: form.tenant_id,
      tenant: ctx.tenant, to: ctx.toEmail, subject, body, brand: ctx.brandSlug,
      leadId: link.lead_id, signer: ctx.signer, cc: ctx.ccEmail,
    });
    if (!result.sent) {
      await logFailureMarker(db, form, link.lead_id, APP_COMPLETE_SOURCE, subject, body, ctx.toEmail, ctx.ccEmail, result.reason, {
        application_complete: true, bank_statement_url: bankUrl,
      });
      console.error("[forms.app_complete] send did not fire", { lead_id: link.lead_id, reason: result.reason });
    }
  } catch (err) {
    console.error("[forms.app_complete] threw", {
      lead_id: input.link.lead_id, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Final full-application receipt. Unlike the legacy app-complete handoff above,
 * this fires for the current form that already collects bank statements in-flow.
 * It confirms receipt to the merchant and CCs the authoritatively assigned rep.
 */
export async function maybeSendApplicationReceivedEmail(input: MaybeSendNextStepsInput): Promise<void> {
  try {
    const { db, form, link, payload } = input;
    const ctx = await loadHandoffContext(db, form, link, payload);
    if (!ctx) return;
    // This is the variant with no second chance: the application is COMPLETE, so
    // there is no later submit to retry on. A drop here is permanent.
    const receivedGate = await alreadySent(
      db,
      form.tenant_id,
      link.lead_id,
      APPLICATION_RECEIVED_SOURCE,
      APPLICATION_RECEIVED_SUBJECT_PREFIX,
    );
    if (receivedGate === "skipped_check_failed") {
      await logIdempotencyCheckFailure(
        db, form, link.lead_id, APPLICATION_RECEIVED_SOURCE, ctx.toEmail, ctx.ccEmail,
      );
      return;
    }
    if (receivedGate === "skipped_already_sent") return;

    const greeting = ctx.toName && ctx.toName.trim()
      ? `Hi ${ctx.toName.trim().split(/\s+/)[0]},`
      : "Hi there,";
    const subject = `Application received - ${ctx.brandLabel}`;
    const body = [
      greeting,
      "",
      `We've received your completed application with ${ctx.brandLabel}.`,
      "",
      "Our team will review the information and bank statements you submitted. We'll contact you if anything else is needed and will keep you updated on next steps.",
      "",
      "Reply to this email if you have any questions.",
      "",
      `- ${ctx.signer.name}`,
      ctx.brandLabel,
    ].join("\n");

    const result = await sendViaBridge({
      db,
      source: APPLICATION_RECEIVED_SOURCE,
      tenantId: form.tenant_id,
      tenant: ctx.tenant,
      to: ctx.toEmail,
      subject,
      body,
      brand: ctx.brandSlug,
      leadId: link.lead_id,
      signer: ctx.signer,
      cc: ctx.ccEmail,
    });
    if (!result.sent) {
      await logFailureMarker(
        db,
        form,
        link.lead_id,
        APPLICATION_RECEIVED_SOURCE,
        subject,
        body,
        ctx.toEmail,
        ctx.ccEmail,
        result.reason,
        { application_received: true },
      );
      console.error("[forms.application_received] send did not fire", {
        lead_id: link.lead_id,
        reason: result.reason,
      });
    }
  } catch (err) {
    console.error("[forms.application_received] threw", {
      lead_id: input.link.lead_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
