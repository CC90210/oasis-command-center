import type { Metadata } from "next";

/**
 * Where a click lands when we cannot tell whose it was.
 *
 * `/api/track/click/[id]` resolves the tenant's own landing page when it knows
 * the tenant. When it does not — an unsigned link, a tracking id that matches
 * nothing — it needs somewhere to send the visitor, and that somewhere used to
 * be SunBiz's intake form. #454 changed it to the platform's front door, which
 * only moved the problem: oasisai.work IS OASIS AI's marketing site, so a
 * SunBiz merchant with a dead link was handed to another company's sales page.
 * The same leak, pointing the other way.
 *
 * So: a page that belongs to neither company. No logo, no product name, no
 * call to action, nothing that reads as a pitch from anyone. It says what
 * happened and stops. A visitor here arrived by accident and is owed an
 * explanation, not an upsell.
 *
 * Deliberately NOT in the (marketing) route group — that shell is OASIS AI's
 * chrome, which would put us back where we started.
 */
export const metadata: Metadata = {
  title: "Link expired",
  robots: { index: false, follow: false },
};

export default function LinkExpiredPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#faf9f5] px-6 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-[#111827]">
          This link has expired
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-[#4b5563]">
          We could not verify where it was meant to take you, so we have not
          sent you anywhere. Nothing is wrong with your account and nothing was
          submitted.
        </p>
        <p className="mt-4 text-[15px] leading-relaxed text-[#4b5563]">
          If someone sent you this link, ask them for a fresh one — tracking
          links are single-purpose and stop working once they are rewritten or
          time out.
        </p>
      </div>
    </main>
  );
}
