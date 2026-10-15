"use client";

import { useEffect, useRef } from "react";
import { purchaseConversionPayload } from "@/lib/marketing/google-ads";
import { AD_CONSENT_CHANGED_EVENT, readAdConsent } from "@/lib/marketing/ad-consent";

const STORAGE_PREFIX = "oasis:google-ads:purchase:";

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/** Fire once per browser tab and Stripe session, after the server verified payment. */
export function PurchaseConversion({
  valueCad,
  transactionId,
  sendTo,
}: {
  valueCad: number;
  transactionId: string;
  sendTo: string;
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
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      if (sent) return;
      // A gtag left on the page after No thanks is not permission to send.
      if (readAdConsent(localStore()) === "denied") return;
      if (typeof window.gtag !== "function") {
        attempts += 1;
        if (attempts < 40) timer = setTimeout(send, 100);
        return;
      }
      const payload = purchaseConversionPayload({ valueCad, transactionId, sendTo });
      if (!payload) return;
      window.gtag("event", "conversion", payload);
      sent = true;
      try {
        window.sessionStorage.setItem(storageKey, "sent");
      } catch {
        // The event has already been queued; an unavailable storage API should
        // not turn a paid purchase into a missing conversion.
      }
    };
    send();
    // The tag loads only after the visitor allows ad cookies (AdConsent). A
    // buyer who allows them after the 4 s poll above gave up still counts;
    // one who declines never gets a gtag, so nothing is sent.
    const onConsent = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== "granted") return;
      attempts = 0;
      send();
    };
    window.addEventListener(AD_CONSENT_CHANGED_EVENT, onConsent);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(AD_CONSENT_CHANGED_EVENT, onConsent);
    };
  }, [sendTo, transactionId, valueCad]);

  return null;
}
