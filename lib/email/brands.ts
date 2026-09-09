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

export type BrandKey = "sunbiz" | "bluerise" | "oasis";

export const ALL_BRAND_KEYS: readonly BrandKey[] = ["sunbiz", "bluerise", "oasis"] as const;

/**
 * Brands that take part in the SunBiz drip A/B split.
 *
 * OASIS is deliberately NOT here. The drip system rotates a merchant between
 * two funding brands at one premises; OASIS is a different company selling a
 * different thing, and a lead must never rotate INTO it. Anything that pairs
 * or alternates brands iterates this, not ALL_BRAND_KEYS.
 */
export const DRIP_BRAND_KEYS: readonly DripBrandKey[] = ["sunbiz", "bluerise"] as const;

/** The brands the drip engine, its send budget and the SMS lane understand. */
export type DripBrandKey = Extract<BrandKey, "sunbiz" | "bluerise">;

export function isDripBrand(key: BrandKey): key is DripBrandKey {
  return key === "sunbiz" || key === "bluerise";
}

/**
 * Narrow a brand to the drip lane, or throw.
 *
 * Throwing is correct here and not merely defensive. The drip engine sends
 * funding-sequence mail on behalf of SunBiz and Bluerise; there is no OASIS
 * drip, no OASIS send budget and no OASIS SMS provider. A drip row carrying
 * brand "oasis" is a data fault, and the alternatives to throwing are to send
 * it as SunBiz — the exact misattribution this file's 2026-09-09 change exists
 * to stop — or to silently skip it, which loses a merchant's follow-up with no
 * signal. Unreachable today: brandForSend only ever returns a drip brand.
 */
export function toDripBrand(key: BrandKey, context: string): DripBrandKey {
  if (!isDripBrand(key)) {
    throw new Error(
      `${context}: brand "${key}" is not part of the drip lane ` +
        `(${DRIP_BRAND_KEYS.join(", ")}). Refusing to reassign it to a funding brand.`,
    );
  }
  return key;
}

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
    // STREET ADDRESS ONLY. The legal entity is rendered separately by
    // brand-shell.ts, so including it here would print the name twice.
    postalAddress:
      env("SUNBIZ_POSTAL_ADDRESS") ||
      "221 W Hallandale Beach Blvd, Suite 518, Hallandale, FL 33009",
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
    // STREET ADDRESS ONLY, as above. Same premises as SunBiz.
    postalAddress:
      env("BLUERISE_POSTAL_ADDRESS") ||
      "221 W Hallandale Beach Blvd, Suite 518, Hallandale, FL 33009",
    trackingOrigin: safeOrigin(env("BLUERISE_TRACKING_ORIGIN")),
    credentialService: "gws_bluerise",
    accent: "#2E6BE6",
    logoUrl: env("BLUERISE_LOGO_URL") || null,
  }),

  /**
   * OASIS AI Solutions — CC's own company, and the reason this registry gained
   * a third entry on 2026-09-09.
   *
   * OASIS was missing here while `resolveBrandKey` coerced every unknown value
   * to "sunbiz". So `resolveBrandKey("oasis")` returned "sunbiz": an OASIS send
   * that reached this layer acquired the CLIENT's from-address, credential row,
   * postal address and legal name. A SunBiz contact reported the visible half
   * of that on 2026-09-09, and the ledger holds the inverse too (tenant
   * oasis-ai-cc sending as sunbiz, 2026-07-10).
   *
   * Values mirror send_gateway.BRAND_IDENTITY["oasis"] and
   * email_template.BRAND_CONFIG["oasis"] in Business-Empire-Agent, which the
   * headers of this file and email-signature.ts already name as the source of
   * truth. Change those first, then this.
   */
  oasis: () => ({
    key: "oasis",
    displayName: env("OASIS_FROM_NAME") || "OASIS AI",
    legalName: "OASIS AI Solutions",
    // The shared team mailbox (lib/integrations/oasis-shared-gmail-send.ts).
    // OASIS_MAIL_FROM is the name that path already reads, so one variable
    // moves the address everywhere rather than two that can disagree.
    fromAddress: env("OASIS_MAIL_FROM") || "conaugh@oasisai.work",
    sendingDomain: "oasisai.work",
    // NOT A STREET ADDRESS, and knowingly so.
    //
    // Every OASIS email already ships exactly this line, and inventing a street
    // to satisfy the shape would be worse than the gap: this file's own rule is
    // that a borrowed or invented address is "affirmatively misleading rather
    // than merely incomplete". CASL s.6(2) wants a real mailing address, so
    // this is a real compliance gap — flagged for CC, not papered over. Set
    // OASIS_POSTAL_ADDRESS once there is a street address that receives mail.
    postalAddress: env("OASIS_POSTAL_ADDRESS") || "Montreal, QC, Canada",
    trackingOrigin: safeOrigin(env("OASIS_TRACKING_ORIGIN")),
    // Its own credential row — never "gws", which is SunBiz's. This is the
    // link that made the brand decide which mailbox authenticates, and so the
    // link that turned a missing brand into a send from the client's mailbox.
    credentialService: "oasis_gmail",
    accent: "#00d4ff",
    logoUrl: env("OASIS_LOGO_URL") || "https://oasisai.work/oasis-logo.jpg",
  }),
};

/**
 * Resolve a stored brand value to a brand key.
 *
 * ABSENT (undefined / null / blank) resolves to `sunbiz`, and that is
 * deliberate: every drip lead in the CRM predates the `sending_brand` column
 * and is a SunBiz lead, so an empty column genuinely means SunBiz. Lender
 * shop-out relies on the same rule (tests/shopout-brand-lock.test.ts).
 *
 * UNRECOGNISED throws. It used to resolve to `sunbiz` too, which meant a typo,
 * a tenant slug passed where a brand was wanted, or the string "oasis" — not a
 * BrandKey until 2026-09-09 — all silently became the client. That is how OASIS
 * mail acquired SunBiz Funding LLC's from-address, credential row and legal
 * footer, and it read as correct on every CI run because two tests asserted it.
 *
 * Use `resolveBrandKeyOrNull` where absent must NOT become a company.
 */
export function resolveBrandKey(raw: unknown): BrandKey {
  const s = String(raw ?? "").trim().toLowerCase();
  if ((ALL_BRAND_KEYS as readonly string[]).includes(s)) return s as BrandKey;

  // ABSENT is still SunBiz, and only absent.
  //
  // Every drip lead in the CRM predates `sending_brand` and is a SunBiz lead;
  // reading an empty column as SunBiz is what keeps those rows on the brand
  // they have always been on. That is the one case the old blanket fallback
  // got right, and it stays.
  if (!s) return "sunbiz";

  // A NON-EMPTY value we do not recognise is a bug, not a default.
  //
  // Until 2026-09-09 this returned "sunbiz" for anything at all — a typo, a
  // tenant slug used where a brand was wanted, or the string "oasis", which was
  // not a brand in this file. That last one is how an OASIS send acquired the
  // client's from-address, credential row and legal identity. Failing loudly
  // turns a silent misattribution into a stack trace with the offending value
  // in it.
  throw new Error(
    `unknown brand ${JSON.stringify(raw)} — known: ${ALL_BRAND_KEYS.join(", ")}. ` +
      "Refusing to fall back: guessing a brand picks a company's legal identity.",
  );
}

/**
 * The brand, or nothing — for callers where "nobody said" must not become a
 * company.
 *
 * `resolveBrandKey` still answers "sunbiz" for an absent value because a drip
 * lead with an empty column genuinely is a SunBiz lead. That is wrong
 * everywhere else: on the identity, footer, signer and credential paths an
 * absent brand means the caller lost it, and turning that into a legal sender
 * identity is the defect this whole change exists to remove. Those callers use
 * this and refuse on null.
 */
export function resolveBrandKeyOrNull(raw: unknown): BrandKey | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return (ALL_BRAND_KEYS as readonly string[]).includes(s) ? (s as BrandKey) : null;
}

/**
 * The brand, or an exception. Use where a send is about to happen.
 *
 * `context` names the call site so the failure says which path lost the brand
 * rather than just that one did.
 */
export function requireBrandKey(raw: unknown, context: string): BrandKey {
  const key = resolveBrandKeyOrNull(raw);
  if (!key) {
    throw new Error(
      `${context}: no usable brand (got ${JSON.stringify(raw)}). ` +
        `Expected one of: ${ALL_BRAND_KEYS.join(", ")}. A commercial email must ` +
        "state a real sender identity, so this refuses rather than defaulting.",
    );
  }
  return key;
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
