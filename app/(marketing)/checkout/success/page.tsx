import type { Metadata } from "next";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { CtaLink } from "@/components/marketing/Cta";
import { PurchaseConversion } from "@/components/marketing/PurchaseConversion";
import { Reveal } from "@/components/marketing/Reveal";
import { resolveCheckoutOffer } from "@/lib/checkout/catalog";
import { verifyOfferCheckout } from "@/lib/checkout/stripe";
import { googleAdsPurchaseDestination } from "@/lib/marketing/google-ads";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payment received",
  description: "Your OASIS AI checkout confirmation.",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CheckoutSuccessPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).session_id;
  const checkoutSessionId = typeof raw === "string" ? raw : "";
  const secretKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  const conversionDestination = googleAdsPurchaseDestination(
    process.env.GOOGLE_ADS_PURCHASE_CONVERSION_DESTINATION,
  );

  try {
    if (!secretKey) throw new Error("stripe_not_connected");
    const receipt = await verifyOfferCheckout({ secretKey, checkoutSessionId, resolveOffer: resolveCheckoutOffer });
    if (!conversionDestination) {
      console.error("[public-checkout.success] Google Ads purchase conversion destination is not configured");
    }
    return (
      <section className="relative overflow-hidden px-5 py-24 sm:px-8 sm:py-32">
        <Reveal>
          <div className="mx-auto max-w-2xl border border-status-engaged/40 bg-ops-panel/90 p-7 text-center backdrop-blur sm:p-12">
            <CheckCircle2 className="mx-auto h-12 w-12 text-status-engaged" aria-hidden="true" />
            <p className="mt-6 font-data text-[10px] uppercase tracking-[0.26em] text-status-engaged">Payment verified</p>
            <h1 className="mt-4 font-display text-[clamp(2rem,6vw,3.4rem)] font-bold tracking-tight text-fg">
              You&rsquo;re in.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              We received your {receipt.optionLabel.toLowerCase()} {receipt.offerName} payment. The OASIS team will email the kickoff details and next steps.
            </p>
            <dl className="mx-auto mt-8 grid max-w-lg gap-3 border-y border-ops-line py-5 text-left text-sm sm:grid-cols-2">
              <div><dt className="text-fg-dim">Amount</dt><dd className="mt-1 font-semibold text-fg">${receipt.valueCad.toLocaleString("en-CA")} CAD</dd></div>
              <div><dt className="text-fg-dim">Transaction</dt><dd className="mt-1 break-all font-data text-xs text-fg">{receipt.transactionId}</dd></div>
            </dl>
            <div className="mt-8"><CtaLink href="/onboarding">View the 7-day onboarding plan</CtaLink></div>
          </div>
        </Reveal>
        {conversionDestination ? (
          <PurchaseConversion
            valueCad={receipt.valueCad}
            transactionId={receipt.transactionId}
            sendTo={conversionDestination}
          />
        ) : null}
      </section>
    );
  } catch (error) {
    console.error("[public-checkout.success]", error);
    return (
      <section className="px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-xl border border-ops-edge bg-ops-panel p-7 text-center sm:p-10">
          <CircleAlert className="mx-auto h-10 w-10 text-status-warm" aria-hidden="true" />
          <h1 className="mt-5 font-display text-3xl font-bold text-fg">We couldn&rsquo;t verify this receipt.</h1>
          <p className="mt-4 leading-relaxed text-fg-muted">
            No conversion was recorded. If Stripe confirmed your payment, contact OASIS and include the checkout reference from your receipt.
          </p>
          <div className="mt-7"><CtaLink href="/contact" variant="secondary">Contact OASIS</CtaLink></div>
        </div>
      </section>
    );
  }
}
