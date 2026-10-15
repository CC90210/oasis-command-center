"use client";

/* Hallmark · component: consent banner · genre: modern-minimal · theme: OCC marketing tokens
 * states: default · hover · focus (global .marketing :focus-visible ring) · active
 *         disabled/loading: n/a (the choice is instant and local) · error: storage blocked,
 *         choice applies to this page only and the banner asks again next visit · success: closes
 * contrast: fg on ops-raised, fg-muted body on ops-raised (tests/marketing-contrast.test.ts)
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AD_CONSENT_CHANGED_EVENT,
  AD_CONSENT_OPEN_EVENT,
  installGoogleAdsTag,
  readAdConsent,
  withdrawGoogleAdsConsent,
  writeAdConsent,
  type AdConsent as Choice,
} from "@/lib/marketing/ad-consent";

/**
 * The ad-cookie choice for the public site. Nothing from Google loads until
 * the visitor presses "Allow"; see lib/marketing/ad-consent.ts for why.
 *
 * Both buttons share one style on purpose: refusing must be exactly as easy
 * and as visible as accepting (Law 25 consent must be free and informed; a
 * bright "Allow" beside a grey "No thanks" is the classic dark pattern).
 * tests/ad-consent.test.ts pins that.
 *
 * Non-modal: the page stays usable and nothing is decided by ignoring it,
 * since ignoring it leaves the tag off. Opening from the footer moves focus
 * into the banner; choosing returns it to where it was.
 */

const CHOICE_BUTTON =
  "inline-flex min-h-11 min-w-[7.5rem] items-center justify-center rounded-md border border-ops-edge bg-ops-panel px-5 py-2.5 text-[15px] font-medium text-fg transition-colors hover:border-fg-dim hover:bg-ops-void active:translate-y-px";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function announce(choice: Choice) {
  window.dispatchEvent(new CustomEvent(AD_CONSENT_CHANGED_EVENT, { detail: choice }));
}

export function AdConsent() {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const firstButton = useRef<HTMLButtonElement | null>(null);
  const loaded = useRef(false);

  // Decide after hydration, never on the server: the server cannot know the
  // choice, and rendering the banner there would flash it for people who chose.
  useEffect(() => {
    if (readAdConsent(storage()) === "granted") {
      installGoogleAdsTag(window, document);
      loaded.current = true;
    } else if (readAdConsent(storage()) === null) {
      setOpen(true);
    }
    const reopen = () => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
      requestAnimationFrame(() => firstButton.current?.focus());
    };
    window.addEventListener(AD_CONSENT_OPEN_EVENT, reopen);
    return () => window.removeEventListener(AD_CONSENT_OPEN_EVENT, reopen);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    returnFocus.current?.focus();
    returnFocus.current = null;
  }, []);

  function allow() {
    writeAdConsent(storage(), "granted");
    installGoogleAdsTag(window, document);
    loaded.current = true;
    announce("granted");
    close();
  }

  function decline() {
    writeAdConsent(storage(), "denied");
    if (loaded.current) {
      // A loaded tag told "denied" can still send cookieless pings, so
      // withdrawal ends with a reload: the page comes back with no Google code.
      withdrawGoogleAdsConsent(window, document, window.location.hostname);
      announce("denied");
      window.location.reload();
      return;
    }
    announce("denied");
    close();
  }

  if (!open) return null;

  return (
    // Direct children of .marketing are forced to position:relative by
    // marketing.css; this zero-size wrapper takes that rule so the banner
    // itself can stay fixed to the viewport.
    <div>
      <section
        aria-labelledby="ad-consent-title"
        className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-3xl rounded-lg border border-ops-edge bg-ops-raised p-4 shadow-2xl shadow-black/60 sm:inset-x-6 sm:bottom-6 sm:p-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <h2 id="ad-consent-title" className="text-[15px] font-semibold text-fg">
              Ad cookies
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">
              We would like to use a Google Ads cookie to see which of our ads bring people here. It stays off
              unless you allow it, and you can change your mind any time from the footer.{" "}
              <Link href="/privacy" className="text-fg underline underline-offset-2 hover:text-signal">
                Privacy policy
              </Link>
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <button ref={firstButton} type="button" onClick={allow} className={CHOICE_BUTTON}>
              Allow
            </button>
            <button type="button" onClick={decline} className={CHOICE_BUTTON}>
              No thanks
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Footer control that reopens the banner, so consent can be withdrawn later. */
export function AdConsentSettingsButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(AD_CONSENT_OPEN_EVENT))}
      className="text-sm text-fg-muted transition-colors hover:text-fg"
    >
      Ad cookie choices
    </button>
  );
}
