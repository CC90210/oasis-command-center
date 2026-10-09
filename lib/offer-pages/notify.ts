/**
 * lib/offer-pages/notify.ts - a new lead on an offer page alerts someone.
 *
 * WHY (design F6/S4). The submit route's alerts were wired to two exact forms
 * (OASIS's `start` and `ai-audit`), so a form built in the builder alerted
 * nobody: a drop box. Every offer page now alerts on a NEW lead's first step.
 *
 * WHO HEARS IT. The workspace's own audience, through the one resolver every
 * alert uses (lib/notify/alert-route.ts pushWorkspaceAlert): OASIS's own
 * workspaces reach OASIS's operator chat; a client workspace reaches only the
 * Telegram bot it connected itself, or nobody outside the app (the builder
 * says so before publishing); a retired workspace pages no one. A client's
 * lead can never reach OASIS's Telegram, because no lane is named here.
 *
 * ONCE PER LEAD. lib/forms/first-submission.ts, the same rule the AI-audit
 * step-0 alert uses, so two racing step-0 submits give exactly one alert.
 * OASIS's `start` and `ai-audit` keep their own alerts and are never alerted
 * twice; a support desk's form never creates a lead at all.
 *
 * Runs inside after(), on a request that already captured the lead: every
 * branch soft-fails, and a delivery that fails leaves a marker on the lead's
 * own timeline (lib/forms/alert-failure.ts), never silence.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "@libsql/client";
import { alertAudienceFor, pushWorkspaceAlert, type AlertPush } from "@/lib/notify/alert-route";
import { workspaceTelegramOutcome } from "@/lib/notify/workspace-telegram";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { isFirstSubmissionForLead } from "@/lib/forms/first-submission";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { AI_AUDIT_SLUG, AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { OASIS_FUNNEL_SLUG, OASIS_FUNNEL_TENANT_ID } from "@/lib/forms/oasis-funnel-seed";
import { SUPPORT_FORM_SLUG, SUPPORT_FORM_TENANT_ID } from "@/lib/delivery/support-form";
import { hasOfferPage } from "./store";

/** Marker source for an undeliverable offer alert (never an idempotency key). */
export const OFFER_ALERT_SOURCE = "offer_page_alert";

/**
 * Forms with an alert of their own, by EXACT workspace and slug (never a
 * prefix): the generic offer alert stays out of their way.
 */
export function hasOwnFunnelAlert(form: { tenant_id: string; slug: string }): boolean {
  return (
    (form.tenant_id === AI_AUDIT_TENANT_ID && form.slug === AI_AUDIT_SLUG) ||
    (form.tenant_id === OASIS_FUNNEL_TENANT_ID && form.slug === OASIS_FUNNEL_SLUG) ||
    (form.tenant_id === SUPPORT_FORM_TENANT_ID && form.slug === SUPPORT_FORM_SLUG)
  );
}

/** The alert, Telegram HTML with every visitor-typed value escaped. */
export function buildOfferLeadAlert(offerName: string, answers: Record<string, unknown>): string {
  const e = escapeTelegramHtml;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = answers[k];
      if (typeof v === "string" && v.trim()) return e(v.trim().slice(0, 200));
    }
    return "";
  };
  const name = pick("name", "contact_name", "full_name") || "Someone";
  const company = pick("company", "business_name");
  const email = pick("email", "business_email", "contact_email");
  const phone = pick("phone", "mobile", "owner_cell");
  const website = pick("website");
  return [
    `New lead from the offer page "${e(offerName.slice(0, 120))}"`,
    "",
    `${name}${company ? ` - ${company}` : ""}`,
    email ? `Email: ${email}` : "",
    phone ? `Phone: ${phone}` : "",
    website ? `Website: ${website}` : "",
    "",
    "Lead - no booking yet. They are in the pipeline now.",
  ]
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** A client that connected no bot chose to hear nothing outside the app: not a failure. */
const NOT_CONNECTED = workspaceTelegramOutcome({ ok: false, reason: "workspace_telegram_not_connected" });

// The builder's line about who hears of a new lead is ./alert-status.ts: it
// reads the Telegram card's status, which this send path never needs.

export type OfferAlertResult = "sent" | "not_offer" | "repeat" | "not_sent";

export async function notifyOfferLead(input: {
  db: SupabaseClient;
  offers: Client | null;
  tenantId: string;
  formId: string;
  formName: string;
  leadId: string;
  submissionId: string;
  answers: Record<string, unknown>;
  push?: (tenantId: string, text: string) => Promise<AlertPush>;
}): Promise<OfferAlertResult> {
  const { db, offers, tenantId, formId, leadId, submissionId } = input;
  if (!offers) return "not_offer";
  try {
    if (!(await hasOfferPage(offers, tenantId, formId))) return "not_offer";
  } catch (err) {
    console.error("[offer-pages.notify] could not tell whether the form has a page", {
      form_id: formId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "not_offer";
  }
  if (!(await isFirstSubmissionForLead({ db, tenantId, formId, leadId, submissionId }))) return "repeat";

  const push = input.push ?? pushWorkspaceAlert;
  const sent = await push(tenantId, buildOfferLeadAlert(input.formName, input.answers)).catch(
    (err: unknown): AlertPush => ({ delivered: false, outcome: `Not sent: ${err instanceof Error ? err.message : "error"}` }),
  );
  if (sent.delivered) return "sent";
  // A retired workspace pages nobody by design; a client with no bot hears in the app.
  if (alertAudienceFor(tenantId) !== "card_only" && sent.outcome !== NOT_CONNECTED) {
    await recordAlertFailure({
      db,
      tenantId,
      leadId,
      source: OFFER_ALERT_SOURCE,
      label: `offer page "${input.formName}"`,
      reason: sent.outcome,
      tag: "offer-pages.notify",
    });
  }
  return "not_sent";
}
