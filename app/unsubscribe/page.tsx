/**
 * /unsubscribe — CASL-compliant public unsubscribe landing.
 *
 * Reached from email footers (DEFAULT_UNSUBSCRIBE_BASE in
 * Business-Empire-Agent/scripts/casl_compliance.py). Anonymous — no
 * Supabase session required, since recipients may not have an account.
 *
 * Accepts (all optional, all in query string):
 *   ?email=<addr>     the recipient address that was emailed
 *   ?brand=<name>     "OASIS AI" / "SunBiz" — the sender brand to suppress
 *   ?token=<hmac>     (future) HMAC-signed proof the recipient owns the email
 *
 * Today the URL is just `?email=...`. Token support is wired in the API
 * route (no-op without OASIS_UNSUBSCRIBE_HMAC_SECRET env var) so we can
 * sign new emails without redeploying when the upgrade lands.
 *
 * Confirmation flow (CASL-safe): visiting the URL does NOT auto-suppress.
 * The recipient must click the "Confirm unsubscribe" button to record the
 * suppression. This prevents accidental opt-outs from preview/clipboard
 * pasting and matches every well-known transactional email vendor.
 */

import UnsubscribeForm from "./UnsubscribeForm";
import { CONTACT_EMAIL } from "@/lib/marketing/routes";

export const dynamic = "force-dynamic";

type SearchParams = {
  email?: string;
  brand?: string;
  token?: string;
};

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const email = (params.email || "").trim().toLowerCase();
  const brand = (params.brand || "").trim();
  const token = (params.token || "").trim();

  return (
    <main className="min-h-screen bg-[#050810] text-[#f5f7fa] flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg bg-[#0c1220] border border-[rgba(0,212,255,0.18)] rounded-2xl p-8 sm:p-10 shadow-[0_12px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="text-center mb-8">
          <div className="text-[11px] tracking-[0.18em] uppercase text-[#00d4ff] font-semibold mb-3">
            {brand ? brand : "OASIS AI"} · Email Preferences
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold mb-2">
            Unsubscribe
          </h1>
          <p className="text-[#a8b0bd] text-sm leading-relaxed">
            You&apos;re about to stop receiving marketing emails
            {brand ? <> from <span className="text-white font-medium">{brand}</span></> : ""}.
            {email ? <> One-click confirmation is required by law (CASL).</> : ""}
          </p>
        </div>

        {email ? (
          <UnsubscribeForm email={email} brand={brand} token={token} />
        ) : (
          <>
            {/* No address in the link: the recipient types it and the opt-out
                goes through /api/unsubscribe like a linked one, into the
                email_suppressions table every sender checks. The form offers
                writing to the inbox as the fallback (ManualOptOut says why it
                is not the first choice). */}
            <p className="text-[#a8b0bd] text-sm mb-4 text-center">
              This link did not include your email address. Type the address
              that received the email, then confirm.
            </p>
            <UnsubscribeForm email="" brand={brand} token={token} />
          </>
        )}

        <div className="mt-10 pt-6 border-t border-[rgba(255,255,255,0.06)] text-center">
          <p className="text-[11px] text-[#6b7280] leading-relaxed">
            {/* Montreal, not Collingwood (CC confirmed 2026-09-09). Every OASIS
                email footer already said Montreal while this page said
                Collingwood, so the opt-out page a recipient lands on disagreed
                with the message that sent them there — on the one page whose
                whole job is a legally-required identification. */}
            OASIS AI Solutions · 6993 Decarie Blvd, Montreal, QC H3W 0B5, Canada<br />
            Questions? <a href={`mailto:${CONTACT_EMAIL}`} className="text-[#00d4ff] underline">{CONTACT_EMAIL}</a>
          </p>
        </div>
      </div>
    </main>
  );
}
