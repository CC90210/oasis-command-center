"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { OasisLogo } from "@/components/brand/OasisLogo";

const GTAG_ID = "AW-18509362419";
const STORAGE_KEY = "gtag_conversion_fired";

export default function CheckoutSuccessPage() {
  const searchParams = useSearchParams();
  const [fired, setFired] = useState(false);

  const sessionId = searchParams.get("session_id") || "";
  const amountTotal = searchParams.get("amount_total");
  const clientRef = searchParams.get("client_reference_id") || sessionId;

  useEffect(() => {
    if (!sessionId && !amountTotal) return;
    if (sessionStorage.getItem(STORAGE_KEY) === clientRef) return;
    if (typeof window.gtag !== "function") return;

    const value = amountTotal ? parseFloat(amountTotal) / 100 : 0;

    window.gtag("event", "conversion", {
      send_to: GTAG_ID,
      value: value,
      currency: "CAD",
      transaction_id: clientRef,
    });

    sessionStorage.setItem(STORAGE_KEY, clientRef);
    setFired(true);
  }, [sessionId, amountTotal, clientRef]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ops-void px-6 py-20">
      <div className="w-full max-w-md space-y-8 text-center">
        <div className="flex justify-center">
          <OasisLogo size={40} />
        </div>

        <div className="space-y-4">
          <div className="flex justify-center">
            <CheckCircle2 className="h-16 w-16 text-signal" />
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
            Payment confirmed
          </h1>
          <p className="text-fg-muted">
            Thank you. Your payment has been received and your workspace is
            being provisioned.
          </p>
          {fired && (
            <p className="text-sm text-fg-dim">
              Conversion tracked for Google Ads.
            </p>
          )}
        </div>

        <div className="border border-ops-line bg-ops-panel p-6 text-left space-y-3">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.15em] text-fg-dim">
            Order details
          </h2>
          {amountTotal && (
            <div className="flex justify-between text-sm">
              <span className="text-fg-muted">Amount</span>
              <span className="font-semibold text-fg">
                ${(parseFloat(amountTotal) / 100).toFixed(2)} CAD
              </span>
            </div>
          )}
          {clientRef && (
            <div className="flex justify-between text-sm">
              <span className="text-fg-muted">Reference</span>
              <span className="font-mono text-xs text-fg truncate max-w-[200px]">
                {clientRef.slice(0, 20)}...
              </span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <Link href="/login" className={`${CTA_PRIMARY} w-full`}>
            Go to your workspace
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href="/"
            className="text-sm text-fg-muted hover:text-fg transition-colors"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
