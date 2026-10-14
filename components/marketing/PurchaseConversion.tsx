"use client";

import { useEffect, useRef } from "react";

export const GOOGLE_ADS_TAG_ID = "AW-18509362419";
const STORAGE_PREFIX = "oasis:google-ads:purchase:";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function purchaseConversionPayload(input: {
  valueCad: number;
  transactionId: string;
}) {
  return {
    send_to: GOOGLE_ADS_TAG_ID,
    value: input.valueCad,
    currency: "CAD" as const,
    transaction_id: input.transactionId,
  };
}

/** Fire once per browser tab and Stripe session, after the server verified payment. */
export function PurchaseConversion({
  valueCad,
  transactionId,
}: {
  valueCad: number;
  transactionId: string;
}) {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const storageKey = `${STORAGE_PREFIX}${transactionId}`;
    try {
      if (window.sessionStorage.getItem(storageKey) === "sent") return;
    } catch {
      // Storage can be unavailable in privacy modes. The in-memory ref still
      // prevents React Strict Mode from firing twice during this page lifetime.
    }

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      if (typeof window.gtag !== "function") {
        attempts += 1;
        if (attempts < 40) timer = setTimeout(send, 100);
        return;
      }
      window.gtag("event", "conversion", purchaseConversionPayload({ valueCad, transactionId }));
      try {
        window.sessionStorage.setItem(storageKey, "sent");
      } catch {
        // The event has already been queued; an unavailable storage API should
        // not turn a paid purchase into a missing conversion.
      }
    };
    send();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [transactionId, valueCad]);

  return null;
}
