import type { Metadata } from "next";
import "@/app/(marketing)/marketing.css";
import { offerFontVariables } from "@/app/fonts/offer-fonts";
import { BookingPage, type BookingField } from "@/components/booking/BookingPage";
import { resolveConsentIdentity } from "@/lib/consent/ledger-identity";
import { AI_AUDIT_TENANT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";
import { BOOK_FORM_SLUG, publicBookingDurationMinutes } from "@/lib/forms/public-booking-config";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { parseFormBranding, parseFormSteps, type FormBranding, type FormStep } from "@/lib/forms/types";
import { getServiceSupabase } from "@/lib/supabase-server";

/**
 * oasisai.work/book - the OASIS booking link (CC, 2026-10-16).
 *
 * The one link every form, offer page, DM and follow-up can point to when the
 * goal is simply a meeting. It leads with the live calendar (open times from
 * GET /api/forms/booking/slots), then takes the four details a call needs, then
 * books: the lead is created or matched once (POST /api/forms/submit, the "book"
 * form, lib/forms/oasis-book-seed.ts) and the call is booked with that lead's
 * token (POST /api/forms/booking). Same video call invite, Sales pipeline move,
 * sales-desk alert and Schedule copy as every other booking.
 *
 * When the "book" form is missing or switched off the page says so and points
 * to the AI audit instead of drawing a calendar that cannot book.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Book a call | OASIS AI",
  description: "Pick a time for a 30-minute video call with OASIS AI.",
  alternates: { canonical: "/book" },
  // Like every public form page: reached by link, not by search.
  robots: { index: false, follow: false },
};

const ALLOWED_TYPES = new Set(["text", "email", "phone", "select", "textarea"]);

function firstParam(value: string | string[] | undefined, max = 120): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const text = typeof raw === "string" ? raw.trim() : "";
  return text && text.length <= max ? text : undefined;
}

function parsedSteps(value: unknown): FormStep[] | null {
  try {
    return parseFormSteps(typeof value === "string" ? (JSON.parse(value) as unknown) : value);
  } catch {
    return null;
  }
}

function parsedBranding(value: unknown): FormBranding {
  try {
    return parseFormBranding(typeof value === "string" ? (JSON.parse(value) as unknown) : value);
  } catch {
    return {};
  }
}

export default async function BookPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const resolved = await resolvePublicForm(getServiceSupabase(), AI_AUDIT_TENANT_SLUG, BOOK_FORM_SLUG);
  // A read that failed is not "booking is closed": thrown, it draws the app's
  // error page with a retry (app/error.tsx) and is reported (2026-10-19 audit).
  if (!resolved.ok && resolved.reason === "unavailable") throw new Error(`booking form unavailable: ${resolved.error}`);
  const steps = resolved.ok ? parsedSteps(resolved.form.steps) : null;
  // The page draws step 0 itself; a field type it cannot draw would make a
  // required answer impossible to give, so it falls back instead of guessing.
  const fields: BookingField[] | null =
    steps && steps.length === 1 && steps[0].fields.every((f) => ALLOWED_TYPES.has(f.type))
      ? steps[0].fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type as BookingField["type"],
          required: Boolean(f.required),
          placeholder: f.placeholder ?? "",
          help: f.help ?? "",
          maxLength: f.maxLength ?? null,
          options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
        }))
      : null;

  const consentIdentity = resolved.ok
    ? resolveConsentIdentity({ tenantId: resolved.form.tenant_id, tenantSlug: resolved.tenant_slug }).identity
    : null;
  const branding = resolved.ok ? parsedBranding(resolved.form.branding) : {};

  return (
    <div className={`marketing ${offerFontVariables} min-h-screen bg-ops-void font-body text-fg antialiased`}>
      {resolved.ok && fields && consentIdentity ? (
        <BookingPage
          tenantSlug={resolved.tenant_slug}
          formSlug={BOOK_FORM_SLUG}
          durationMinutes={publicBookingDurationMinutes(BOOK_FORM_SLUG)}
          headline={branding.headline || "Book a call with OASIS AI"}
          subheadline={branding.subheadline || ""}
          thanksMessage={branding.thanks_message || ""}
          fields={fields}
          consentIdentity={consentIdentity}
          attribution={{
            rep: firstParam(sp.rep, 64),
            source: firstParam(sp.source, 32),
            utm_source: firstParam(sp.utm_source),
            utm_medium: firstParam(sp.utm_medium),
            utm_campaign: firstParam(sp.utm_campaign),
            kw: firstParam(sp.kw),
          }}
        />
      ) : (
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-20">
          <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">OASIS AI</p>
          <h1 className="mt-5 font-display text-3xl font-semibold tracking-[-0.02em] text-fg">
            Online booking is closed right now.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
            Tell us about your business and we will reach out to set up a time.
          </p>
          <a
            href={`/f/${AI_AUDIT_TENANT_SLUG}/ai-audit`}
            className="mt-8 inline-flex w-fit items-center justify-center rounded-md bg-signal px-6 py-3 text-[15px] font-semibold text-ops-void hover:brightness-110"
          >
            Start the AI audit
          </a>
        </main>
      )}
    </div>
  );
}
