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

export function ClaimForm({
  scanId,
  businessName,
  website,
  consentIdentity,
  onClaimed,
}: {
  scanId: string;
  businessName: string;
  website: string;
  consentIdentity: ConsentIdentity;
  onClaimed: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<Record<ConsentChannel, boolean>>({ email: false, sms: false });
  const idBase = useId();
  const inFlight = useRef(false);
  const trapRef = useRef<HTMLInputElement | null>(null);
  const trapLatch = useRef("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const trapped = trapValue(trapRef.current, trapLatch);
    if (trapped) {
      await reportTrappedSubmission({ anonymous_init: { tenant_slug: AUDIT_FUNNEL.tenantSlug, form_slug: AUDIT_FUNNEL.formSlug }, step_index: 0 }, trapped);
      onClaimed();
      return;
    }
    const context = { submissionPath: window.location.pathname, visitId: getOrCreateVisitId(), attribution: auditAttributionFromSearch(window.location.search) };
    const body = auditFormBody(new FormData(e.currentTarget), context);
    const problem = auditFormProblem(body.payload);
    if (problem) {
      setError(problem);
      setStatus("error");
      inFlight.current = false;
      return;
    }
    setStatus("sending");
    setError(null);
    try {
      const res = await fetch("/api/forms/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; minted_token?: string | null } | null;
      if (!res.ok || !data?.ok) {
        if (isSubmitFault(res.status, data)) {
          sendSubmitFailureBeacon({ tenantSlug: body.anonymous_init.tenant_slug, formSlug: body.anonymous_init.form_slug, stepIndex: 0, error: data?.error ?? `non_json_http_${res.status}`, payload: body.payload, consentLedger: body.consent_ledger });
        }
        setError(data?.error === "rate_limited" ? "Too many attempts just now. Give it a minute and try again." : `That didn't go through. Try again, or email ${CONTACT_EMAIL}.`);
        setStatus("error");
        inFlight.current = false;
        return;
      }
      if (data.minted_token) {
        const claim = await fetch(`/api/scan/${encodeURIComponent(scanId)}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: data.minted_token }) });
        if (!claim.ok) console.error("[scan.claim] link failed", claim.status);
      }
      onClaimed();
    } catch {
      sendSubmitFailureBeacon({ tenantSlug: body.anonymous_init.tenant_slug, formSlug: body.anonymous_init.form_slug, stepIndex: 0, error: "network_error", payload: body.payload, consentLedger: body.consent_ledger });
      setError("Couldn't reach the server. Check your connection and try again.");
      setStatus("error");
      inFlight.current = false;
    }
  }

  const sending = status === "sending";
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <HoneypotField inputRef={trapRef} />
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
      {error ? <p role="alert" className="text-[14px] text-status-warm sm:col-span-2">{error}</p> : null}
      <div className="sm:col-span-2">
        <button type="submit" disabled={sending} className={CTA_PRIMARY}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Email me the report
          {!sending ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
        </button>
      </div>
    </form>
  );
}
