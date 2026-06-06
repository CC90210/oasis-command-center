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
            You're about to stop receiving marketing emails
            {brand ? <> from <span className="text-white font-medium">{brand}</span></> : ""}.
            {email ? <> One-click confirmation is required by law (CASL).</> : ""}
          </p>
        </div>

        {email ? (
          <UnsubscribeForm email={email} brand={brand} token={token} />
        ) : (
          <div className="text-center">
            <p className="text-[#a8b0bd] text-sm mb-4">
              No email address was provided in the URL. If you got here from an
              email link, please copy the full link from your email and try
              again, or write to{" "}
              <a
                href="mailto:unsubscribe@oasisai.work"
                className="text-[#00d4ff] underline"
              >
                unsubscribe@oasisai.work
              </a>{" "}
              to opt out manually.
            </p>
          </div>
        )}

        <div className="mt-10 pt-6 border-t border-[rgba(255,255,255,0.06)] text-center">
          <p className="text-[11px] text-[#6b7280] leading-relaxed">
            OASIS AI Solutions · Collingwood, ON, Canada<br />
            Questions? <a href="mailto:conaugh@oasisai.work" className="text-[#00d4ff] underline">conaugh@oasisai.work</a>
          </p>
        </div>
      </div>
    </main>
  );
}
