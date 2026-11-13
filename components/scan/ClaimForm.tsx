"use client";

import { useId, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { auditAttributionFromSearch, auditFormBody, auditFormProblem, AUDIT_CONSENT_FIELDS } from "@/components/marketing/audit-form-body";
import { ConsentChoice } from "@/components/forms/ConsentChoice";
import { HoneypotField } from "@/components/forms/HoneypotField";
import type { ConsentChannel, ConsentIdentity } from "@/lib/consent/ledger-disclosure";
import { reportTrappedSubmission, trapValue } from "@/lib/forms/honeypot";
import { isSubmitFault, sendSubmitFailureBeacon } from "@/lib/forms/submit-failure-beacon";
import { getOrCreateVisitId } from "@/lib/offers/tracking-client";
import { AUDIT_FUNNEL, CONTACT_EMAIL } from "@/lib/marketing/routes";

/**
 * Claiming a scan = step 0 of the live ai-audit funnel, the same POST the homepage form makes
 * (one lead pipeline, not two), then POST /api/scan/:id/claim with the minted token so the scan
 * becomes that lead's audit. Company and website are prefilled from the scan.
 */

const FIELD = "w-full border border-ops-edge bg-ops-void/40 px-3 py-2.5 text-[15px] text-fg placeholder:text-fg-dim focus:border-signal focus:outline-none";

const CLAIM_ERRORS: Record<string, string> = {
  audit_not_opened: "Your details reached us, but the audit could not be opened for them automatically. The OASIS team will follow up with you directly.",
  wrong_form: "This report can only be saved through the form on this page. Reload the page and try again.",
  bad_claim_key: "This report can only be saved from the browser that ran the scan. Run your own free scan above and save that one.",
  rate_limited: "Too many attempts just now. Give it a minute and try again.",
};

export function ClaimForm({
  scanId,
  claimKey,
  businessName,
  website,
  consentIdentity,
  formSlug = AUDIT_FUNNEL.formSlug,
  onClaimed,
}: {
  scanId: string;
  claimKey: string;
  businessName: string;
  website: string;
  consentIdentity: ConsentIdentity;
  /** The form the claim submits: the scan's own offer form when it is on (lib/site-scan/claim.ts scanClaimFormSlug). */
  formSlug?: string;
  onClaimed: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "sending" | "error" | "closed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<Record<ConsentChannel, boolean>>({ email: false, sms: false });
  const idBase = useId();
  const inFlight = useRef(false);
  const trapRef = useRef<HTMLInputElement | null>(null);
  const trapLatch = useRef("");
  // The lead's token once the form went through: a retry re-sends only the claim, never a second lead.
  const minted = useRef<string | null>(null);
  const [leadSent, setLeadSent] = useState(false);

  function fail(message: string, final = false) {
    setError(message);
    setStatus(final ? "closed" : "error");
    inFlight.current = false;
  }

  /** Link the lead to the scan. Resolves only on a confirmed claim; every refusal is shown here. */
  async function claim(token: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`/api/scan/${encodeURIComponent(scanId)}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, claim_key: claimKey }) });
    } catch {
      return fail("Your details were sent, but the report could not be saved to them. Check your connection and press the button again.");
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (res.ok && data?.ok) {
      onClaimed();
      return;
    }
    const code = data?.error ?? "";
    console.error("[scan.claim] link refused", { status: res.status, code });
    if (code === "audit_not_opened" || code === "bad_claim_key" || code === "wrong_form") return fail(CLAIM_ERRORS[code], true);
    fail(CLAIM_ERRORS[code] ?? `Your details were sent, but the report could not be saved to them. Press the button again, or email ${CONTACT_EMAIL}.`);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current || status === "closed") return;
    inFlight.current = true;
    if (minted.current) {
      setStatus("sending");
      setError(null);
      await claim(minted.current);
      return;
    }
    const trapped = trapValue(trapRef.current, trapLatch);
    if (trapped) {
      await reportTrappedSubmission({ anonymous_init: { tenant_slug: AUDIT_FUNNEL.tenantSlug, form_slug: formSlug }, step_index: 0 }, trapped);
      onClaimed();
      return;
    }
    const context = { submissionPath: window.location.pathname, visitId: getOrCreateVisitId(), attribution: auditAttributionFromSearch(window.location.search) };
    // The audit's first-step fields, filed under the form this claim belongs to (the scan's own offer).
    const built = auditFormBody(new FormData(e.currentTarget), context);
    const body = { ...built, anonymous_init: { ...built.anonymous_init, form_slug: formSlug } };
    const problem = auditFormProblem(body.payload);
    if (problem) return fail(problem);
    setStatus("sending");
    setError(null);
    // The beacon is for the form submission alone: a failure after the lead exists is not a lost lead.
    let res: Response;
    try {
      res = await fetch("/api/forms/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      sendSubmitFailureBeacon({ tenantSlug: body.anonymous_init.tenant_slug, formSlug: body.anonymous_init.form_slug, stepIndex: 0, error: "network_error", payload: body.payload, consentLedger: body.consent_ledger });
      return fail("Couldn't reach the server. Check your connection and try again.");
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; minted_token?: string | null } | null;
    if (!res.ok || !data?.ok) {
      if (isSubmitFault(res.status, data)) {
        sendSubmitFailureBeacon({ tenantSlug: body.anonymous_init.tenant_slug, formSlug: body.anonymous_init.form_slug, stepIndex: 0, error: data?.error ?? `non_json_http_${res.status}`, payload: body.payload, consentLedger: body.consent_ledger });
      }
      return fail(data?.error === "rate_limited" ? CLAIM_ERRORS.rate_limited : `That didn't go through. Try again, or email ${CONTACT_EMAIL}.`);
    }
    if (!data.minted_token) {
      // The lead exists, but without a token nothing can prove it is this report's.
      console.error("[scan.claim] form accepted without a minted token");
      return fail(`Your details reached us, but this report could not be saved to them. The OASIS team will follow up, or email ${CONTACT_EMAIL}.`, true);
    }
    minted.current = data.minted_token;
    setLeadSent(true);
    await claim(data.minted_token);
  }

  const sending = status === "sending";
  const closed = status === "closed";
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <HoneypotField inputRef={trapRef} />
      {/* Once the lead is saved its details are fixed: a retry re-sends only the claim, so an edit here would be shown but never stored. */}
      <fieldset disabled={leadSent} className="m-0 grid min-w-0 gap-4 border-0 p-0 sm:col-span-2 sm:grid-cols-2 disabled:opacity-70">
      <label className="block">
        <span className="font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">Your name</span>
        <input name="name" autoComplete="name" required className={`${FIELD} mt-1.5`} />
      </label>
      <label className="block">
        <span className="font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">Work email</span>
        <input name="email" type="email" autoComplete="email" required className={`${FIELD} mt-1.5`} />
      </label>
      <label className="block">
        <span className="font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">Mobile (with country code)</span>
        <input name="phone" type="tel" autoComplete="tel" placeholder="+1 514 555 0123" required className={`${FIELD} mt-1.5`} />
      </label>
      <label className="block">
        <span className="font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">Company</span>
        <input name="company" autoComplete="organization" defaultValue={businessName} required className={`${FIELD} mt-1.5`} />
      </label>
      <input type="hidden" name="website" value={website} />
      <div className="sm:col-span-2 space-y-2">
        {(["email", "sms"] as const).map((channel) => (
          <ConsentChoice key={channel} id={`${idBase}-${channel}`} channel={channel} identity={consentIdentity} checked={consent[channel]} onChange={(checked) => setConsent((c) => ({ ...c, [channel]: checked }))} name={AUDIT_CONSENT_FIELDS[channel]} variant="marketing" />
        ))}
      </div>
      </fieldset>
      {leadSent ? (
        <p className="text-[13px] text-fg-dim sm:col-span-2">
          Your details are saved. To change them, email {CONTACT_EMAIL}.
        </p>
      ) : null}
      {error ? <p role="alert" className="text-[14px] text-status-warm sm:col-span-2">{error}</p> : null}
      <div className="sm:col-span-2">
        <button type="submit" disabled={sending || closed} className={CTA_PRIMARY}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {leadSent ? "Save the report again" : "Send it to the OASIS team"}
          {!sending ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
        </button>
      </div>
    </form>
  );
}
