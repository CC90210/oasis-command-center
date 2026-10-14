"use client";

import { useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { cad, type CheckoutOffer } from "@/lib/checkout/catalog";

type CheckoutState = "idle" | "loading" | "error";

export function PricingCheckout({ offer }: { offer: CheckoutOffer }) {
  const [optionId, setOptionId] = useState(offer.options[0].id);
  const [state, setState] = useState<CheckoutState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const selected = offer.options.find((option) => option.id === optionId) ?? offer.options[0];

  async function startCheckout() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("loading");
    setMessage(null);
    try {
      const response = await fetch("/api/checkout/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id: offer.id, option_id: selected.id }),
      });
      const result = await response.json().catch(() => null) as
        | { ok?: boolean; url?: string; error?: string }
        | null;
      if (!response.ok || !result?.ok || !result.url?.startsWith("https://checkout.stripe.com/")) {
        const copy = result?.error === "rate_limited"
          ? "Too many checkout attempts just now. Wait a minute and try again."
          : "Secure checkout is temporarily unavailable. Please try again or contact us.";
        setState("error");
        setMessage(copy);
        inFlight.current = false;
        return;
      }
      window.location.assign(result.url);
    } catch {
      setState("error");
      setMessage("We couldn't reach secure checkout. Check your connection and try again.");
      inFlight.current = false;
    }
  }

  return (
    <div className="mt-7">
      <label className="block text-sm font-medium text-fg-muted" htmlFor={`scope-${offer.id}`}>
        Choose scope
      </label>
      <select
        id={`scope-${offer.id}`}
        value={optionId}
        onChange={(event) => setOptionId(event.target.value)}
        disabled={state === "loading"}
        className="mt-2 w-full rounded-md border border-ops-edge bg-ops-void/70 px-3.5 py-3 text-[15px] text-fg outline-none transition-colors focus:border-signal"
      >
        {offer.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label} - {cad(option.amountCents)}
          </option>
        ))}
      </select>
      <p className="mt-3 min-h-12 text-sm leading-relaxed text-fg-dim">{selected.description}</p>
      <button
        type="button"
        onClick={startCheckout}
        disabled={state === "loading"}
        className={`${CTA_PRIMARY} mt-4 w-full`}
      >
        {state === "loading" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Opening secure checkout
          </>
        ) : (
          <>
            Get started - {cad(selected.amountCents)}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </>
        )}
      </button>
      <p className="mt-3 text-center text-xs text-fg-dim">One-time payment in CAD. Processed securely by Stripe.</p>
      <p role="status" aria-live="polite" className={`mt-3 text-sm ${message ? "text-status-hot" : "sr-only"}`}>
        {message ?? "Checkout ready."}
      </p>
    </div>
  );
}
