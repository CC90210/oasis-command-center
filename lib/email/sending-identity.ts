/**
 * lib/email/sending-identity.ts — the single source of truth for WHO outbound
 * drip mail is from, and WHERE its links point.
 *
 * Built 2026-07-29 so the move from SunBiz to Bluerise Business Capital is a set
 * of environment variables rather than a hunt through the codebase. Before this,
 * the sending identity was scattered across five files as string literals: the
 * From address, the unsubscribe mailto, the Message-Id domain, the click
 * allowlist, and the safe-redirect default. Changing brand meant finding all of
 * them and missing one.
 *
 * Pure, no I/O, no "server-only", so the cutover rules are unit-testable.
 *
 * EVERY DEFAULT IS TODAY'S BEHAVIOUR. With nothing set, this resolves to exactly
 * the SunBiz values that were previously hardcoded. The cutover is config.
 */

import { resolveTrackingBase, trackingHost } from "./tracking-base";
import { ALL_BRAND_KEYS, getBrand, resolveBrandKey, type BrandKey } from "./brands";

/** What the sender was before any of this was configurable. Kept as the default
 *  so an unset environment is byte-identical to the pre-2026-07-29 behaviour. */
const LEGACY_FROM = "submissions@sunbizfunding.com";
const LEGACY_PLATFORM = "https://oasisai.work";

function env(name: string): string | undefined {
  const v = (process.env[name] || "").trim();
  return v ? v : undefined;
}

/**
 * The address drip mail is sent From. Per-tenant overrides still win at send
 * time (see getSubmissionsFrom); this is the fallback and the identity that
 * everything else here is derived from.
 *
 * The optional `brand` makes this per-SEND rather than global (2026-08-05).
 * Omitting it resolves to SunBiz, which is what every pre-existing caller does
 * and why this change is safe to deploy before any routing exists.
 */
export function fromAddress(brand?: BrandKey): string {
  return getBrand(resolveBrandKey(brand)).fromAddress;
}

/**
 * The domain of an address, lowercased. Empty when unparseable.
 *
 * MUST handle the RFC 5322 display-name form, not just a bare mailbox:
 * getSubmissionsFrom() returns `SunBiz Submissions <submissions@sunbizfunding.com>`,
 * and naively taking everything after the last "@" yields `sunbizfunding.com>`
 * with the bracket attached. That produced a malformed Message-Id
 * (`<uuid@sunbizfunding.com>>`) on every send, which receivers may rewrite or
 * reject and which breaks the persisted threading identifiers (Codex review P1).
 */
export function domainOfAddress(addr: string): string {
  const raw = (addr || "").trim();
  // Prefer the bracketed mailbox when the string is a display-name form.
  const angled = /<([^<>]+)>\s*$/.exec(raw);
  const mailbox = (angled ? angled[1] : raw).trim();
  const at = mailbox.lastIndexOf("@");
  if (at < 0) return "";
  return mailbox
    .slice(at + 1)
    .trim()
    .replace(/[>\s]+$/, "")
    .toLowerCase();
}

/**
 * The human-readable name shown in front of the From address, for the DRIP path
 * only. Undefined means "leave it alone", which is today's behaviour.
 *
 * Exists because getSubmissionsFrom() hardcodes "SunBiz Submissions", and that
 * function is SHARED with lender shop-out mail. A global rename would rebrand
 * lender correspondence at the same moment as the merchant drips, which may not
 * be intended. Setting DRIP_FROM_NAME moves only the drips and leaves everything
 * else on the shared default, so the Bluerise cutover no longer waits on that
 * decision — it works either way.
 *
 * Sanitized: CR/LF and quotes are stripped. This value ends up in a mail header,
 * and a newline in a header value is header injection. It is operator-set rather
 * than user-set, so this is defence in depth, not the primary control.
 */
export function fromDisplayName(): string | undefined {
  const raw = env("DRIP_FROM_NAME");
  if (!raw) return undefined;
  const clean = raw.replace(/[\r\n"<>]/g, " ").replace(/\s+/g, " ").trim();
  return clean || undefined;
}

/** The domain part of the CONFIGURED From address. Drives the unsubscribe mailto
 *  so it can never disagree with the visible sender.
 *
 *  Note for the Message-Id: prefer the RESOLVED per-tenant sender where one is
 *  available (see submissions-gmail-send.ts). This global value is the fallback,
 *  and using it unconditionally would stamp one tenant's domain onto another
 *  tenant's mail. */
export function fromDomain(brand?: BrandKey): string {
  const key = resolveBrandKey(brand);
  return domainOfAddress(fromAddress(key)) || getBrand(key).sendingDomain;
}

/**
 * The mailto: half of the RFC 8058 List-Unsubscribe header.
 *
 * Derived from the From address rather than configured separately, because a
 * mailto pointing at a different domain than the sender is both a deliverability
 * signal and a dead end for the recipient: replies to it may not even be
 * deliverable once the old mailbox is retired.
 */
export function unsubscribeMailto(brand?: BrandKey): string {
  return `mailto:${fromAddress(brand)}?subject=unsubscribe`;
}

/** The domain used to synthesize RFC 5322 Message-Ids. Must match the sending
 *  domain or receivers see a Message-Id that does not correspond to the sender,
 *  which some filters score against. */
export function messageIdDomain(brand?: BrandKey): string {
  return fromDomain(brand);
}

/** The shared platform origin. */
export function platformOrigin(): string {
  return resolveTrackingBase(undefined, env("PUBLIC_APP_URL") || LEGACY_PLATFORM);
}

/**
 * The origin drip tracking, unsubscribe and per-lead application links are built
 * on. Keyed to the sending PATH, not to a brand name, because the brand is what
 * is changing.
 *
 * Unset falls back to the platform origin, which is the current behaviour and is
 * why this is safe to deploy before any DNS exists.
 */
export function trackingOrigin(brand?: BrandKey): string {
  const key = resolveBrandKey(brand);
  // DRIP_TRACKING_BASE_URL remains the SunBiz-side name so anything already
  // configured keeps working; Bluerise gets its own so the two can move apart.
  const configured =
    key === "sunbiz"
      ? env("DRIP_TRACKING_BASE_URL") || env("SUNBIZ_TRACKING_ORIGIN")
      : env("BLUERISE_TRACKING_ORIGIN");
  return resolveTrackingBase(configured, platformOrigin());
}

/**
 * THE SUPPRESSION BRAND, and the sharpest edge in this whole cutover.
 *
 * This string is NOT cosmetic. /api/unsubscribe resolves it to a tenant
 * (tenants.name ILIKE <brand>) when RECORDING an opt-out. If it ever fails to
 * match a real tenant, the suppression row lands with tenant_id = NULL, and
 * checkEmailSuppressed — which filters by tenant_id — will never honor it. The
 * unsubscribe silently does nothing and the merchant keeps receiving mail.
 *
 * The good news, verified 2026-07-29: enforcement keys on (tenant_id, email) and
 * does NOT consult the brand, so previously recorded suppressions keep working
 * through a rebrand. The hazard is only on the WRITE path, and only for
 * suppressions recorded AFTER the brand changes.
 *
 * So this deliberately does NOT follow the From address. Changing who the mail
 * is from must not silently repoint where opt-outs are filed. If Bluerise sends
 * as its own tenant, set this to that tenant's exact name. If it sends under the
 * existing tenant, leave it alone. scripts/verify-email-domain.mjs checks that
 * whatever is set here actually resolves to a tenant before you go live.
 */
export function suppressionBrand(): string {
  return env("DRIP_SUPPRESSION_BRAND") || "SunBiz";
}

/** Where the generic CTA sends a lead that has no per-lead application link. The
 *  one link in an outbound email that is free to point at any website at all,
 *  including a marketing site this app does not serve. */
export function intakeUrl(): string {
  return env("DRIP_INTAKE_URL") || `${platformOrigin()}/f/submissions/initial-lead-capture`;
}

/**
 * Hosts a click may redirect to WITHOUT a valid signature.
 *
 * Derived rather than hardcoded so it cannot drift from what actually mints the
 * links. The legacy hosts stay because mail already in inboxes points at them and
 * must keep working long after the cutover: a merchant opening a three-week-old
 * email should still land on the right page, not the safe default.
 *
 * UNIONS EVERY BRAND, deliberately, and takes no brand argument.
 *
 * This route serves clicks on mail that was sent at some point in the PAST. After
 * a brand handoff the merchant's inbox still holds messages minted on the
 * previous brand's origin, and those cannot be re-sent. Scoping this to the
 * brand a lead is on TODAY would silently downgrade every click on that older
 * mail to SAFE_DEFAULT, which presents as a dead campaign rather than a config
 * error. Breadth here is correct; the narrowing happens at signature
 * verification, not at the allowlist.
 *
 * This is also load-bearing rather than defence-in-depth while
 * OASIS_UNSUBSCRIBE_HMAC_SECRET is unset in production: with no secret,
 * signClickTarget() returns empty, every link ships unsigned, and this set is
 * the ONLY thing deciding where a merchant lands.
 */
export function clickAllowedHosts(): Set<string> {
  // LEGACY hosts, unconditional and never derived. Every message sent before
  // this file existed points at these, and overriding DRIP_FROM_ADDRESS must
  // not evict them — that would strand years of mail already in inboxes.
  const hosts = new Set([
    "oasisai.work",
    "www.oasisai.work",
    "sunbizfunding.com",
    "www.sunbizfunding.com",
  ]);

  for (const key of ALL_BRAND_KEYS) {
    // The sending domain itself, and its www form, so a hand-written link in a
    // template body to the brand's own site is not downgraded.
    const sending = fromDomain(key).toLowerCase();
    if (sending) {
      hosts.add(sending);
      hosts.add(`www.${sending}`);
    }
    // The configured tracking host for that brand, when it is a valid https
    // origin. A malformed value contributes NOTHING rather than widening the
    // allowlist — this is the one place that must fail closed, because the
    // allowlist decides where an unsigned link may send a merchant.
    const tracking = trackingHost(trackingOrigin(key));
    if (tracking) hosts.add(tracking);
  }

  // The CTA destination may be an entirely separate marketing site.
  try {
    const intake = new URL(intakeUrl());
    if (intake.protocol === "https:") hosts.add(intake.hostname.toLowerCase());
  } catch {
    /* an unparseable intake URL contributes nothing rather than widening */
  }
  return hosts;
}

/** Everything resolved at once, for the preflight script and for logging a
 *  cutover so the state at send time is recoverable from the audit trail. */
export type SendingIdentity = {
  fromAddress: string;
  fromDomain: string;
  trackingOrigin: string;
  platformOrigin: string;
  intakeUrl: string;
  suppressionBrand: string;
  unsubscribeMailto: string;
  /** True once tracking links are on the sending domain rather than the shared
   *  platform origin — the whole point of the cutover. */
  aligned: boolean;
};

export function sendingIdentity(): SendingIdentity {
  const from = fromAddress();
  const tracking = trackingOrigin();
  const domain = fromDomain();
  let aligned = false;
  try {
    const host = new URL(tracking).hostname.toLowerCase();
    aligned = host === domain || host.endsWith(`.${domain}`);
  } catch {
    aligned = false;
  }
  return {
    fromAddress: from,
    fromDomain: domain,
    trackingOrigin: tracking,
    platformOrigin: platformOrigin(),
    intakeUrl: intakeUrl(),
    suppressionBrand: suppressionBrand(),
    unsubscribeMailto: unsubscribeMailto(),
    aligned,
  };
}
