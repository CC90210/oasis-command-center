"use client";

import { useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { CTA_PRIMARY } from "@/components/marketing/Cta";

/**
 * The site's one conversion point.
 *
 * This is step 0 of the live `ai-audit` funnel, rendered inline. It is not
 * a second lead pipeline — it POSTs the same `anonymous_init` shape the
 * funnel's own first step does, to the same endpoint, and the server
 * creates the same lead row. The four fields here are exactly the four
 * fields step 0 declares (lib/forms/oasis-ai-audit-seed.ts): name, email
 * and company required, website optional. If that seed changes, this has
 * to change with it or the submit fails server-side validation.
 *
 * On success the server returns `minted_token`, and we hand the visitor
 * straight into the funnel's remaining steps at the personalised URL. The
 * lead exists from this moment, so an abandon after this point is still a
 * lead rather than a lost visit.
 *
 * Not FormPublicClient: that component owns multi-step state, conditional
 * field visibility, and direct-to-storage file uploads, none of which a
 * four-field marketing form needs.
 */

type Status = "idle" | "sending" | "error";

export function AuditForm({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  // The in-flight guard has to be a ref, not `status`. React state updates
  // are asynchronous: two submit events dispatched before the next render
  // (double-click, Enter-then-click) would both read "idle" and both POST,
  // creating two leads for one person. A ref mutates synchronously, so the
  // second event sees the first one's flag. The disabled button is a UI
  // affordance, not a guarantee — it only takes effect after that same
  // render.
  const inFlight = useRef(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;

    const form = new FormData(e.currentTarget);
    const payload = {
      name: String(form.get("name") || "").trim(),
      email: String(form.get("email") || "").trim(),
      company: String(form.get("company") || "").trim(),
      website: String(form.get("website") || "").trim(),
    };

    setStatus("sending");
    setError(null);

    try {
      const res = await fetch("/api/forms/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step_index: 0,
          anonymous_init: {
            tenant_slug: AUDIT_FUNNEL.tenantSlug,
            form_slug: AUDIT_FUNNEL.formSlug,
          },
          payload,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; minted_token?: string | null }
        | null;

      if (!res.ok || !data?.ok) {
        // Surface something the visitor can act on. The rate-limit case is
        // the only one they can actually resolve themselves, so it gets its
        // own message instead of the generic one.
        setError(
          data?.error === "rate_limited"
            ? "Too many attempts just now. Give it a minute and try again."
            : "That didn't go through. Try again, or email support@oasisai.work.",
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
      window.location.href = data.minted_token
        ? `${AUDIT_FUNNEL.path}/${encodeURIComponent(data.minted_token)}`
        : AUDIT_FUNNEL.path;
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setStatus("error");
      inFlight.current = false;
    }
  }

  const sending = status === "sending";

  return (
    <form onSubmit={onSubmit} className="w-full" noValidate={false}>
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

      <button
        type="submit"
        disabled={sending}
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
        className={`mt-4 text-sm ${error ? "text-status-hot" : "text-fg-dim"}`}
      >
        {error ?? "Three more screens after this. Takes about two minutes."}
      </p>
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
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      {/* gap-x-3 is load-bearing: justify-between alone lets a long label
          and its hint touch at narrow column widths. */}
      <span className="flex items-baseline justify-between gap-x-3 font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">
        <span>{label}</span>
        {hint ? <span className="shrink-0 text-fg-faint">{hint}</span> : null}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        className="mt-2 w-full border-b border-ops-edge bg-transparent py-2.5 text-[15px] text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-signal"
      />
    </label>
  );
}
