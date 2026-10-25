/**
 * /your-audit/thanks — where Stripe sends the client back. It holds no token
 * and says nothing is confirmed until Stripe confirms it: the payment is
 * verified on the server (lib/ai-audit/payment.ts), never by this visit.
 */
import type { Metadata } from "next";
import { offerFontVariables } from "@/app/fonts/offer-fonts";
import "@/components/ai-audit/doc/audit-document.css";

export const metadata: Metadata = {
  title: "Thank you | OASIS AI",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ThanksPage({ searchParams }: Props) {
  const sp = await searchParams;
  const cancelled = sp.status === "cancelled";
  return (
    <div className={offerFontVariables}>
      <div className="aa">
        <article className="aa-paper" style={{ maxWidth: 560 }}>
          <div className="aa-brand">
            OASIS AI <span>Solutions</span>
          </div>
          {cancelled ? (
            <>
              <h1 style={{ fontSize: 26 }}>Checkout cancelled</h1>
              <p style={{ marginTop: 14 }}>Nothing was charged. You can go back to your audit from the email link whenever you are ready.</p>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 26 }}>Thank you</h1>
              <p style={{ marginTop: 14 }}>
                Stripe is confirming your payment. As soon as it does, we will email you the next steps, including a short onboarding form and a time for our kickoff call.
              </p>
              <p>If anything looks wrong, reply to our email and we will sort it out.</p>
            </>
          )}
        </article>
      </div>
    </div>
  );
}
