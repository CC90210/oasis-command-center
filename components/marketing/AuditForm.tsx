"use client";

import { useId, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { AUDIT_FUNNEL, CONTACT_EMAIL } from "@/lib/marketing/routes";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import {
  AUDIT_CONSENT_FIELDS,
  auditAttributionFromSearch,
  auditFormBody,
  auditFormContinuationPath,
  auditFormProblem,
} from "@/components/marketing/audit-form-body";
import type { ConsentChannel, ConsentIdentity } from "@/lib/consent/ledger-disclosure";
import { ConsentChoice } from "@/components/forms/ConsentChoice";
import { HoneypotField } from "@/components/forms/HoneypotField";
import { reportTrappedSubmission, trapValue } from "@/lib/forms/honeypot";
import { BEACON_ERRORS, sendSubmitFailureBeacon } from "@/lib/forms/submit-failure-beacon";
import { getOrCreateVisitId } from "@/lib/offers/tracking-client";

/**
 * The site's one conversion point.
 *
 * This is step 0 of the live `ai-audit` funnel, rendered inline. It is not
 * a second lead pipeline — it POSTs the same `anonymous_init` shape the
 * funnel's own first step does, to the same endpoint, and the server
 * creates the same lead row. The five fields here are exactly the five
 * fields step 0 declares (lib/forms/oasis-ai-audit-seed.ts): name, email,
 * phone and company required, website optional. The body itself is built by
 * audit-form-body.ts, and tests/audit-form-fields.test.ts fails the build
 * when it and the seed differ — from 2026-08-20 to 2026-10-08 the seed
 * required phone, this form never sent it, and every inline submit got a 400.
 *
 * On success the server returns `minted_token`, and we hand the visitor
 * straight into the funnel's remaining steps at the personalised URL. The
 * lead exists from this moment, so an abandon after this point is still a
 * lead rather than a lost visit.
 *
 * Not FormPublicClient: that component owns multi-step state, conditional
 * field visibility, and direct-to-storage file uploads, none of which a
 * five-field marketing form needs.
 */

/** "trapped": the honeypot caught a script, which is shown a plain thanks. */
type Status = "idle" | "sending" | "error" | "trapped";

export function AuditForm({
  compact = false,
  consentIdentity,
}: {
  compact?: boolean;
  /** Resolved server-side for the same OASIS tenant the submit route resolves. */
  consentIdentity: ConsentIdentity;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [consentTicked, setConsentTicked] = useState<Record<ConsentChannel, boolean>>({
    email: false,
    sms: false,
  });
  const consentIdBase = useId();
  // The in-flight guard has to be a ref, not `status`. React state updates
  // are asynchronous: two submit events dispatched before the next render
  // (double-click, Enter-then-click) would both read "idle" and both POST,
  // creating two leads for one person. A ref mutates synchronously, so the
  // second event sees the first one's flag. The disabled button is a UI
  // affordance, not a guarantee — it only takes effect after that same
  // render.
  const inFlight = useRef(false);
  // The honeypot box (components/forms/HoneypotField.tsx) and what a script typed into it.
  const trapRef = useRef<HTMLInputElement | null>(null);
  const trapLatch = useRef("");

  // Only a script fills the honeypot box. It gets one report the submit route
  // drops (lib/forms/honeypot.ts), never the answers, and a plain thanks: no
  // lead link, no funnel, no calendar. inFlight stays set, so it cannot submit
  // again.
  async function endTrapped(trapped: string) {
    inFlight.current = true;
    await reportTrappedSubmission(
      { anonymous_init: { tenant_slug: AUDIT_FUNNEL.tenantSlug, form_slug: AUDIT_FUNNEL.formSlug }, step_index: 0 },
      trapped,
    );
    setStatus("trapped");
  }

  // The browser's own checks (required, type="email") stop a submit before
  // onSubmit runs and fire "invalid" instead. A script that filled the trap but
  // left a box blank ends here, so it is still caught (Codex review of #672).
  // A visitor's empty trap leaves the browser's message as it was.
  function onInvalid() {
    if (inFlight.current) return;
    const trapped = trapValue(trapRef.current, trapLatch);
    if (trapped) void endTrapped(trapped);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;

    // Read before the form's own checks below (they also refuse a value of only
    // spaces, which the browser accepts) and before anything is tracked.
    const trapped = trapValue(trapRef.current, trapLatch);
    if (trapped) {
      await endTrapped(trapped);
      return;
    }

    const context = {
      submissionPath: window.location.pathname,
      visitId: getOrCreateVisitId(),
      attribution: auditAttributionFromSearch(window.location.search),
    };
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
      const res = await fetch("/api/forms/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; minted_token?: string | null }
        | null;

      if (!res.ok || !data?.ok) {
        // A fault on our side means a prospect who may give up here: beacon,
        // so the answers are kept and someone is paged (independent review of
        // #714). The visitor's own mistakes are the form working.
        if (!data || (data.error !== undefined && BEACON_ERRORS.has(data.error))) {
          sendSubmitFailureBeacon({
            tenantSlug: body.anonymous_init.tenant_slug,
            formSlug: body.anonymous_init.form_slug,
            stepIndex: 0,
            error: data?.error ?? `non_json_http_${res.status}`,
            payload: body.payload,
          });
        }
        // Surface something the visitor can act on. The rate-limit case is
        // the only one they can actually resolve themselves, so it gets its
        // own message instead of the generic one.
        setError(
          data?.error === "rate_limited"
            ? "Too many attempts just now. Give it a minute and try again."
            : `That didn't go through. Try again, or email ${CONTACT_EMAIL}.`,
        );
        setStatus("error");
        inFlight.current = false; // let them correct and retry
        return;
      }

      // Continue into the funnel. Without a token there is nothing to
      // resume, so fall back to the anonymous funnel entry rather than
      // navigating to a broken personalised URL.
      //
      // inFlight is deliberately NOT released here. The navigation is
      // already committed, and clearing it would reopen the double-submit
      // window for however long the browser takes to leave the page.
      const nextPath = data.minted_token
        ? `${AUDIT_FUNNEL.path}/${encodeURIComponent(data.minted_token)}`
        : AUDIT_FUNNEL.path;
      window.location.href = auditFormContinuationPath(nextPath, context);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setStatus("error");
      inFlight.current = false;
    }
  }

  const sending = status === "sending";

  return (
    <form
      onSubmit={onSubmit}
      onInvalidCapture={onInvalid}
      action="/api/forms/submit"
      method="post"
      className="w-full"
      noValidate={false}
    >
      <div className={`grid gap-4 ${compact ? "" : "sm:grid-cols-2"}`}>
        <Field name="name" label="Your name" autoComplete="name" required />
        <Field
          name="email"
          label="Work email"
          type="email"
          autoComplete="email"
          required
        />
        <Field
          name="phone"
          label="Mobile number"
          type="tel"
          autoComplete="tel"
          required
          help={
            <>
              Used only to follow up on this request.{" "}
              <a href="/privacy" className="underline underline-offset-2 hover:text-fg">
                Privacy policy
              </a>
            </>
          }
        />
        <Field
          name="company"
          label="Company"
          autoComplete="organization"
          required
        />
        <Field
          name="website"
          label="Website or socials"
          autoComplete="url"
          hint="Optional"
        />
      </div>

      <div className="mt-5 space-y-3 rounded-md border border-ops-line bg-ops-void/35 p-3.5">
        {(["email", "sms"] as const).map((channel) => (
          // One summary line per box, the full disclosure under "Full terms"
          // (components/forms/ConsentChoice.tsx, CC 2026-10-16).
          <ConsentChoice
            key={channel}
            id={`${consentIdBase}-consent-${channel}`}
            name={AUDIT_CONSENT_FIELDS[channel]}
            channel={channel}
            identity={consentIdentity}
            checked={consentTicked[channel]}
            onChange={(value) => setConsentTicked((current) => ({ ...current, [channel]: value }))}
            variant="marketing"
          />
        ))}
      </div>

      <noscript>
        <p className="mt-4 text-[13px] leading-5 text-status-hot">
          JavaScript is required to submit this secure form. You can also email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </noscript>

      <button
        type="submit"
        disabled={sending || status === "trapped"}
        className={`${CTA_PRIMARY} mt-6 w-full sm:w-auto`}
      >
        {sending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Sending
          </>
        ) : (
          <>
            Start the audit
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </>
        )}
      </button>

      <p
        role="status"
        aria-live="polite"
        className={`mt-4 text-[14px] ${error ? "text-status-hot" : "text-fg-dim"}`}
      >
        {status === "trapped" ? "Thanks. We'll be in touch." : error ?? "Three more screens after this. Takes about two minutes."}
      </p>

      <HoneypotField inputRef={trapRef} />
    </form>
  );
}

function Field({
  name,
  label,
  type = "text",
  required = false,
  autoComplete,
  hint,
  help,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  hint?: string;
  /** Shown under the input and read with it; outside the <label>, so a link in it is never inside the control's label. */
  help?: React.ReactNode;
}) {
  const helpId = help ? `${name}-help` : undefined;
  return (
    <div>
      <label className="block">
        {/* Field labels are the one place tiny mono uppercase actively hurt:
            this is the form the whole site exists to get filled in, and
            10px letterspaced caps is the least readable setting on the page.
            Sentence case, body face, real size.
            gap-x-3 is load-bearing: justify-between alone lets a long label
            and its hint touch at narrow column widths. */}
        <span className="flex items-baseline justify-between gap-x-3 text-[14px] font-medium text-fg-muted">
          <span>{label}</span>
          {hint ? <span className="shrink-0 text-[13px] font-normal text-fg-dim">{hint}</span> : null}
        </span>
        <input
          name={name}
          type={type}
          required={required}
          autoComplete={autoComplete}
          aria-describedby={helpId}
          className="mt-2 w-full rounded-md border border-ops-edge bg-ops-void/60 px-3.5 py-2.5 text-[16px] text-fg outline-none transition-colors placeholder:text-fg-dim hover:border-fg-faint focus:border-signal sm:text-[15px]"
        />
      </label>
      {help ? (
        <p id={helpId} className="mt-1.5 text-[13px] leading-5 text-fg-dim">
          {help}
        </p>
      ) : null}
    </div>
  );
}
