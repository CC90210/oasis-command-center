/**
 * lib/email/brands.ts — the registry that defines a sending brand COMPLETELY.
 *
 * A brand is the whole outbound identity at once: who the mail is from, which
 * credential row authenticates the SMTP session, which origin its links are
 * built on, and the legal entity plus physical postal address that satisfies
 * CAN-SPAM. Keeping them in one place is the point. Before this file those
 * facts were five string literals in five files, and the 2026-08-05 audit found
 * that flipping the "brand" env var moved three of them and left two behind:
 * mail would have claimed Bluerise while being DKIM-signed by sunbizfunding.com,
 * which reads to a receiver as forgery.
 *
 * Pure, no I/O, no "server-only", so the cutover rules stay unit-testable.
 *
 * EVERY SUNBIZ DEFAULT IS THE PREVIOUSLY-HARDCODED VALUE. With nothing
 * configured this resolves byte-identically to pre-2026-08-05 behaviour, which
 * is what makes each task in this series safe to deploy on its own.
 */

export type BrandKey = "sunbiz" | "bluerise";

export const ALL_BRAND_KEYS: readonly BrandKey[] = ["sunbiz", "bluerise"] as const;

export type Brand = {
  key: BrandKey;
  /** Shown in front of the From address and used in copy. */
  displayName: string;
  /** The legal entity named in the CAN-SPAM footer. */
  legalName: string;
  fromAddress: string;
  sendingDomain: string;
  /**
   * CAN-SPAM physical postal address, one line, comma separated.
   *
   * This must be an address at which the sender genuinely receives mail. An
   * invented or borrowed one is worse than a missing one: it is affirmatively
   * misleading rather than merely incomplete. `brandIsSendable` refuses to send
   * without a real value.
   */
  postalAddress: string;
  /** Origin that tracking, unsubscribe and per-lead application links use. */
  trackingOrigin: string;
  /** `tenant_integration_credentials.service` holding this brand's SMTP creds. */
  credentialService: string;
  accent: string;
  logoUrl: string | null;
};

/** Sentinel that marks a brand as not yet cleared to send. */
const POSTAL_UNSET = "BLUERISE_POSTAL_ADDRESS_NOT_SET";

function env(name: string): string | undefined {
  const v = (process.env[name] || "").trim();
  return v ? v : undefined;
}

function platformOrigin(): string {
  return (env("PUBLIC_APP_URL") || "https://oasisai.work").replace(/\/+$/, "");
}

/** Validate a configured origin, falling back when unusable. Fail-SAFE rather
 *  than fail-closed: a bad value here would break every link in every email, so
 *  we keep sending on the known-good platform origin. */
function safeOrigin(configured: string | undefined): string {
  const raw = (configured || "").trim();
  if (!raw) return platformOrigin();
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? `${u.protocol}//${u.host}` : platformOrigin();
  } catch {
    return platformOrigin();
  }
}

const REGISTRY: Record<BrandKey, () => Brand> = {
  sunbiz: () => ({
    key: "sunbiz",
    displayName: env("SUNBIZ_FROM_NAME") || "SunBiz Funding",
    legalName: "SunBiz Funding LLC",
    // DRIP_FROM_ADDRESS stays honoured as the SunBiz override so anything set
    // during the pre-registry work keeps behaving the same.
    fromAddress: env("DRIP_FROM_ADDRESS") || env("SUNBIZ_FROM_ADDRESS") || "submissions@sunbizfunding.com",
    sendingDomain: "sunbizfunding.com",
    // Matches send_gateway.BRAND_IDENTITY["sunbiz"].business_address
    // (provenance: CC provided it 2026-06-17). Change BRAND_IDENTITY first.
    postalAddress:
      env("SUNBIZ_POSTAL_ADDRESS") ||
      "SunBiz Funding LLC, 221 W Hallandale Beach Blvd, Suite 518, Hallandale, FL 33009",
    trackingOrigin: safeOrigin(env("DRIP_TRACKING_BASE_URL") || env("SUNBIZ_TRACKING_ORIGIN")),
    credentialService: "gws",
    accent: "#D4A843",
    logoUrl: env("SUNBIZ_LOGO_URL") || "https://cc90210.github.io/SunBiz-Agent/ads/sunbiz_logo.png",
  }),

  bluerise: () => ({
    key: "bluerise",
    displayName: env("BLUERISE_FROM_NAME") || "Bluerise Business Capital",
    legalName: env("BLUERISE_LEGAL_NAME") || "Bluerise Business Capital LLC",
    // ONE mailbox, deliberately (Adon, 2026-08-05). submissions@ is the only
    // Bluerise account with sign-in history and is the one the warm-up ran
    // through; alex@, jordan@ and matt@ have never signed in, and a pristine
    // never-used mailbox pushing cold outreach is close to the worst sender
    // profile available. Reputation is predominantly DOMAIN-level, so splitting
    // across mailboxes on one domain buys no extra volume - it only splits the
    // warm-up across four cold starts.
    fromAddress: env("BLUERISE_FROM_ADDRESS") || "submissions@bluerisebusinesscapital.com",
    sendingDomain: "bluerisebusinesscapital.com",
    // Adon confirmed 2026-08-05 that Bluerise operates from the SunBiz
    // premises, so this is a real address at which it receives mail. Two
    // companies at one office is ordinary and truthful. Do NOT substitute an
    // invented or merely nearby address.
    postalAddress:
      env("BLUERISE_POSTAL_ADDRESS") ||
      "Bluerise Business Capital, 221 W Hallandale Beach Blvd, Suite 518, Hallandale, FL 33009",
    trackingOrigin: safeOrigin(env("BLUERISE_TRACKING_ORIGIN")),
    credentialService: "gws_bluerise",
    accent: "#2E6BE6",
    logoUrl: env("BLUERISE_LOGO_URL") || null,
  }),
};

/**
 * Resolve any stored or user-supplied value to a brand key.
 *
 * Unknown resolves to `sunbiz` on purpose. That is the pre-existing behaviour
 * and the brand every lead currently in the CRM already knows, so a typo or a
 * missing field can never quietly move a merchant onto the newer domain.
 */
export function resolveBrandKey(raw: unknown): BrandKey {
  const s = String(raw ?? "").trim().toLowerCase();
  return (ALL_BRAND_KEYS as readonly string[]).includes(s) ? (s as BrandKey) : "sunbiz";
}

export function getBrand(key: BrandKey): Brand {
  return REGISTRY[resolveBrandKey(key)]();
}

/**
 * Is this brand cleared to send commercial mail?
 *
 * Called before any real send. A brand without a valid postal address must
 * never reach a merchant, so this fails closed rather than warning.
 */
export function brandIsSendable(key: BrandKey): { ok: true } | { ok: false; reason: string } {
  const b = getBrand(key);
  const postal = (b.postalAddress || "").trim();
  if (!postal || postal === POSTAL_UNSET) {
    return { ok: false, reason: `${b.key}: physical postal address not configured (CAN-SPAM)` };
  }
  if (!b.fromAddress.includes("@")) {
    return { ok: false, reason: `${b.key}: from address is not a mailbox` };
  }
  if (b.fromAddress.split("@")[1].toLowerCase() !== b.sendingDomain) {
    return { ok: false, reason: `${b.key}: from address is not on the sending domain (DKIM would not align)` };
  }
  if (!b.credentialService) {
    return { ok: false, reason: `${b.key}: no credential service configured` };
  }
  return { ok: true };
}
