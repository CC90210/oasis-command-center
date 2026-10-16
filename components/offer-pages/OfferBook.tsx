"use client";

/**
 * OfferBook - the form inside an offer page's Book section (design 2.4).
 *
 * The form is the page's own form, unchanged (FormPublicClient, chrome
 * "embedded"): the same submit route, the same one-lead rule, the same
 * validation before any lead is written. What this adds is the step after the
 * contact details:
 *
 *   - the form ends on the founder calendar on this page (every OASIS offer
 *     form, lib/forms/public-booking-config.ts): "Your details are in", and
 *     the time is picked inline at the end, never through a second link;
 *   - a booking link is configured: a "Pick a time" button (a link in a new
 *     tab, never an embedded calendar), with the remaining questions below it;
 *   - none is configured: "Tell us two times that suit you", by email to the
 *     workspace's contact address when it has one, otherwise an honest "we'll
 *     be in touch" (lib/booking-link.ts: absent is a real answer, never a dead
 *     link).
 *
 * In a preview (signed-in owner, draft page) the form is mounted in preview
 * mode (FormPublicClient `preview`): every step and the live open times work,
 * and nothing is sent, so a preview never creates a lead. With no form at all
 * the steps are listed instead.
 */
import { useState } from "react";
import { FormPublicClient } from "@/components/forms/FormPublicClient";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { isOptionalPublicBookingFormSlug, isPublicBookingSurface } from "@/lib/forms/public-booking-config";
import type { BookMode } from "@/lib/offer-pages/types";
import { ACCENT_BORDER, ACCENT_WASH } from "./styles";

export type EmbeddedFormProps = Omit<Parameters<typeof FormPublicClient>[0], "chrome" | "onStepSubmitted">;

export function OfferBook({
  form,
  mode,
  bookingUrl,
  contactEmail = null,
  previewSteps,
}: {
  form: EmbeddedFormProps | null;
  mode: BookMode;
  bookingUrl: string | null;
  /** Where "two times that suit you" go when there is no booking link. */
  contactEmail?: string | null;
  /** Preview only: the step titles, drawn instead of a live form. */
  previewSteps?: string[];
}) {
  const [contactDone, setContactDone] = useState(false);
  // The form ends on the founder calendar on this same page (FormPublicClient
  // -> PublicBookingCalendar). A "Pick a time" link to the booking page as
  // well would be a second way to book, through a second form and a second lead.
  const calendarOnPage = Boolean(
    form?.tenantSlug && form.formSlug && isPublicBookingSurface({ tenantSlug: form.tenantSlug, formSlug: form.formSlug }),
  );
  // PROTOCOL and COMMUNITY offer the call, never require it (review of #655).
  const callOptional = calendarOnPage && isOptionalPublicBookingFormSlug(form?.formSlug ?? "");

  if (!form) {
    return (
      <div className="rounded-2xl border border-dashed border-ops-edge bg-ops-panel/60 p-6">
        <p className="font-data text-[10px] uppercase tracking-[0.22em] text-fg-dim">Preview</p>
        <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
          The form appears here. A preview never sends anything.
        </p>
        {previewSteps && previewSteps.length ? (
          <ol className="mt-4 space-y-2">
            {previewSteps.map((t, i) => (
              <li key={`${i}-${t}`} className="flex gap-3 text-[14px] text-fg">
                <span className="font-data text-[12px] text-fg-dim">{String(i + 1).padStart(2, "0")}</span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {mode === "form_then_link" && contactDone ? (
        <div className={`rounded-xl border ${ACCENT_BORDER} ${ACCENT_WASH} p-5 sm:p-6`} role="status">
          {calendarOnPage ? (
            <>
              <p className="font-display text-lg font-bold tracking-tight text-fg">Your details are in.</p>
              <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">
                {callOptional
                  ? "A few quick questions below. At the end you can also book a call here, if you would like one."
                  : "A few quick questions below, then you pick a time for the call right here."}
              </p>
            </>
          ) : bookingUrl ? (
            <>
              <p className="font-display text-lg font-bold tracking-tight text-fg">Your details are in. Pick a time that suits you.</p>
              <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">
                The booking page opens in a new tab. The questions below, if any, help us prepare.
              </p>
              <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className={`${CTA_PRIMARY} mt-4 w-full sm:w-auto`}>
                Pick a time
              </a>
            </>
          ) : contactEmail ? (
            <>
              <p className="font-display text-lg font-bold tracking-tight text-fg">Your details are in. Tell us two times that suit you.</p>
              <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">
                Email them to {contactEmail} and we&apos;ll confirm one. The questions below, if any, help us prepare.
              </p>
              <a
                href={`mailto:${contactEmail}?subject=${encodeURIComponent("Two times for a call")}`}
                className={`${CTA_PRIMARY} mt-4 w-full sm:w-auto`}
              >
                Email two times
              </a>
            </>
          ) : (
            <>
              <p className="font-display text-lg font-bold tracking-tight text-fg">Your details are in.</p>
              <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">
                We&apos;ll be in touch to find a time that suits you. The questions below, if any, help us prepare.
              </p>
            </>
          )}
        </div>
      ) : null}
      <FormPublicClient
        {...form}
        chrome="embedded"
        onStepSubmitted={(stepIndex) => {
          if (stepIndex === 0) setContactDone(true);
        }}
      />
    </div>
  );
}
