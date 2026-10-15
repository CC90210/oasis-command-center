import { GOOGLE_ADS_TAG_ID } from "@/lib/marketing/google-ads";

/**
 * Ad-cookie consent for the public marketing site (Quebec Law 25, PIPEDA).
 *
 * The Google Ads tag (PR #610) used to load on every marketing page with no
 * choice offered: it set a DoubleClick third-party cookie and _gcl_au on page
 * load, while /privacy section 5 still said the site had no advertising pixel.
 * Law 25 requires tracking technology to be OFF until the person turns it on,
 * so the tag now loads only after an explicit "Allow" (Google's "basic"
 * consent mode: nothing is requested from Google before that). "No thanks"
 * loads nothing, and the choice can be changed later from the footer.
 *
 * Kept free of React and of `window` globals so tests can drive it with fakes
 * (tests/ad-consent.test.ts). components/marketing/AdConsent.tsx is the only
 * caller, and tests/legal-compliance-drift.test.ts fails if the tag host
 * appears anywhere else.
 */

export const AD_CONSENT_STORAGE_KEY = "oasis:ad-consent:v1";
/** Fired on window after the visitor chooses; PurchaseConversion listens. */
export const AD_CONSENT_CHANGED_EVENT = "oasis:ad-consent-changed";
/** Fired by the footer's "Ad cookie choices" button to reopen the banner. */
export const AD_CONSENT_OPEN_EVENT = "oasis:ad-consent-open";

export const GOOGLE_TAG_SRC = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_TAG_ID}`;
const TAG_SCRIPT_ID = "google-ads-tag";

export type AdConsent = "granted" | "denied";

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** Anything not exactly "granted" or "denied" is "not asked yet". */
export function parseAdConsent(value: unknown): AdConsent | null {
  return value === "granted" || value === "denied" ? value : null;
}

/** Storage can throw (privacy modes, blocked site data): treat as not asked. */
export function readAdConsent(storage: KeyValueStore | null | undefined): AdConsent | null {
  try {
    return parseAdConsent(storage?.getItem(AD_CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Returns false when the choice could not be saved. The choice still applies
 * to the current page view; the banner simply asks again on the next visit,
 * which errs on the side of not tracking.
 */
export function writeAdConsent(storage: KeyValueStore | null | undefined, value: AdConsent): boolean {
  try {
    if (!storage) return false;
    storage.setItem(AD_CONSENT_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record "No thanks" so that no earlier "granted" can survive it. If saving
 * "denied" fails (storage full), the stored grant is deleted instead, so the
 * next load asks again with the tag off. "failed" means neither worked and an
 * old grant may still be readable: the caller must not reload onto it.
 */
export function recordAdDenial(
  storage: (KeyValueStore & Pick<Storage, "removeItem">) | null | undefined,
): "saved" | "cleared" | "failed" {
  if (writeAdConsent(storage, "denied")) return "saved";
  try {
    if (!storage) return "failed";
    storage.removeItem(AD_CONSENT_STORAGE_KEY);
    return readAdConsent(storage) === "granted" ? "failed" : "cleared";
  } catch {
    return "failed";
  }
}

type Gtag = (...args: unknown[]) => void;
export type TagWindow = { dataLayer?: unknown[]; gtag?: Gtag };
export type TagDocument = {
  getElementById(id: string): unknown;
  createElement(tag: "script"): { id: string; src: string; async: boolean };
  head: { appendChild(node: unknown): unknown };
  cookie: string;
};

const GRANTED = {
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
  analytics_storage: "denied",
} as const;

const DENIED = {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
} as const;

/**
 * Load the Google Ads tag. Call ONLY after the visitor chose "Allow".
 * Idempotent: a second call adds no second script. If the tag is already on
 * the page (Allow, No thanks, Allow again), Google is put back to granted.
 */
export function installGoogleAdsTag(win: TagWindow, doc: TagDocument): void {
  if (doc.getElementById(TAG_SCRIPT_ID)) {
    if (typeof win.gtag === "function") win.gtag("consent", "update", GRANTED);
    return;
  }
  win.dataLayer = win.dataLayer || [];
  const dataLayer = win.dataLayer;
  // gtag.js reads the arguments object itself, not an array copy of it.
  win.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params -- the gtag contract
    dataLayer.push(arguments);
  };
  win.gtag("consent", "default", GRANTED);
  win.gtag("js", new Date());
  win.gtag("config", GOOGLE_ADS_TAG_ID);
  const script = doc.createElement("script");
  script.id = TAG_SCRIPT_ID;
  script.async = true;
  script.src = GOOGLE_TAG_SRC;
  doc.head.appendChild(script);
}

/**
 * The host and each parent domain down to two labels:
 * "www.oasisai.work" -> ["www.oasisai.work", "oasisai.work"]. Never the bare TLD.
 */
function cookieDomains(host: string): string[] {
  const labels = host.split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * The visitor changed "Allow" to "No thanks" on this page. Tell an already
 * loaded tag to stop storing and sending ad data, and delete the first-party
 * _gcl_* cookies it set. gtag writes them on the TOP domain (cookie_domain
 * "auto"), so on www.oasisai.work they live on .oasisai.work: every parent
 * domain is expired, not just the host. DoubleClick's own cookie lives on
 * Google's domain: no site can delete it, which /privacy says.
 */
export function withdrawGoogleAdsConsent(win: TagWindow, doc: TagDocument, host: string): void {
  if (typeof win.gtag === "function") win.gtag("consent", "update", DENIED);
  const names = doc.cookie
    .split(";")
    .map((c) => c.split("=")[0]?.trim())
    .filter((n): n is string => !!n && n.startsWith("_gcl_"));
  for (const name of names) {
    for (const base of cookieDomains(host)) {
      for (const domain of [base, `.${base}`]) {
        doc.cookie = `${name}=; Max-Age=0; Path=/; Domain=${domain}`;
      }
    }
    doc.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}
