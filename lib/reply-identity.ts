/**
 * lib/reply-identity.ts — WHICH address a client's automated replies go out as,
 * and what that choice costs.
 *
 * THE DECISION THIS EXISTS TO MAKE EXPLICIT. Every OASIS client site posts to
 * one central backend and one shared agent answers as that client's brand. The
 * From address on those replies was previously free text on
 * client_automation_profiles.reply_from_identity — a string, not a decision.
 * Three different addresses that all "work" have three different blast radii:
 *
 *   shared_oasis          — one mailbox for everybody. ONE sender reputation
 *                           shared by every client OASIS has. The day one
 *                           client's customers start marking replies as spam,
 *                           every other client's mail degrades with it, and
 *                           nothing in the product will say why.
 *   per_client_subaddress — support+acmehvac@oasisai.work. Still one domain
 *                           reputation, but each client gets its own filtering,
 *                           threading and bounce analytics, so the bad actor is
 *                           at least identifiable. No client DNS.
 *   per_client_domain     — hello@acmehvac.com. Full isolation and the best
 *                           recipient trust, paid for with SPF/DKIM/DMARC on
 *                           the client's own DNS BEFORE a single message ships.
 *
 * THERE IS NO DEFAULT, ANYWHERE, ON PURPOSE. Not in this module, not in the
 * column, not in the migration. A default here is a silent decision about
 * somebody else's sender reputation, and the person it would be made for — the
 * client — cannot evaluate it. It is an operator choice at provisioning time,
 * which is also why it is deliberately absent from the client onboarding form.
 *
 * SENDING FROM AN UNVERIFIED CLIENT DOMAIN IS HOW A DOMAIN GETS BLACKLISTED,
 * hence canActivateProfile(): per_client_domain cannot reach status 'active'
 * until dns_verified_at is set. The two migration guards (149) are the backstop;
 * this is the layer that names the missing thing.
 *
 * Pure — no I/O, no database, no "server-only" — so every rule here is
 * unit-testable, the same reason lib/email/sending-identity.ts is pure.
 */

// ---------------------------------------------------------------------------
// The OASIS-owned sending domain
// ---------------------------------------------------------------------------

/**
 * The domain OASIS actually owns and sends from.
 *
 * Named rather than inlined because the shared/subaddress modes are DEFINED as
 * "on a domain we control", and that predicate has to be one edit. The literal
 * is scattered across ~30 unrelated places in this repo (app-URL fallbacks,
 * marketing copy, mailtos); none of those are this question, and none of them
 * should be grep-replaced when the sending domain moves.
 */
export const OASIS_SENDING_DOMAIN = "oasisai.work";

// ---------------------------------------------------------------------------
// The three modes
// ---------------------------------------------------------------------------

export type ReplyIdentityModeSpec = {
  id: string;
  /** What an operator picks from, in an operator's words. */
  label: string;
  /** The one line that makes the tradeoff choosable rather than guessable. */
  tradeoff: string;
  /** True means mail MUST NOT go out until the client's DNS is verified. */
  requiresClientDns: boolean;
  /** True means one client's spam complaints cannot hurt another client. */
  isolatesReputation: boolean;
};

export const REPLY_IDENTITY_MODES = {
  shared_oasis: {
    id: "shared_oasis",
    label: "Shared OASIS address",
    tradeoff:
      "Cheapest and instant — no client DNS. Every client shares ONE sender reputation, " +
      "so one client's spam complaints degrade deliverability for all of them.",
    requiresClientDns: false,
    isolatesReputation: false,
  },
  per_client_subaddress: {
    id: "per_client_subaddress",
    label: "Per-client subaddress on an OASIS domain",
    tradeoff:
      "No client DNS, and each client gets its own threading, filtering and bounce " +
      "analytics. Reputation is still shared at the domain level — isolated enough to " +
      "diagnose, not enough to contain.",
    requiresClientDns: false,
    isolatesReputation: false,
  },
  per_client_domain: {
    id: "per_client_domain",
    label: "The client's own domain",
    tradeoff:
      "Full reputation isolation and the best recipient trust. Requires SPF, DKIM and " +
      "DMARC on the client's DNS first — sending before that is how a domain gets " +
      "blacklisted, and it is the client's domain that pays.",
    requiresClientDns: true,
    isolatesReputation: true,
  },
} as const satisfies Record<string, ReplyIdentityModeSpec>;

export type ReplyIdentityMode = keyof typeof REPLY_IDENTITY_MODES;

/**
 * The three ids, in operator-presentation order (cheapest first).
 *
 * Derived from the record rather than typed a second time: this list is what
 * every error message enumerates and what tests compare against the CHECK
 * constraint in migration 149, so a fourth mode added to the record shows up in
 * both without a second edit.
 */
export const REPLY_IDENTITY_MODE_IDS = Object.keys(REPLY_IDENTITY_MODES) as ReplyIdentityMode[];

/**
 * The modes that send from a domain OASIS does not own, and therefore cannot go
 * live until the client publishes SPF/DKIM/DMARC.
 *
 * Derived from the record rather than listed again, for the same reason
 * REPLY_IDENTITY_MODE_IDS is: a fourth mode that needs DNS must not be able to
 * reach production having been added to the vocabulary but missed by the gate.
 */
export const REPLY_IDENTITY_MODES_REQUIRING_DNS: ReadonlySet<ReplyIdentityMode> = new Set(
  REPLY_IDENTITY_MODE_IDS.filter((id) => REPLY_IDENTITY_MODES[id].requiresClientDns),
);

const MODE_LIST = REPLY_IDENTITY_MODE_IDS.join(", ");

export function isReplyIdentityMode(v: unknown): v is ReplyIdentityMode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(REPLY_IDENTITY_MODES, v);
}

// ---------------------------------------------------------------------------
// Address shape
// ---------------------------------------------------------------------------

type ParsedAddress = { address: string; local: string; base: string; tag: string; domain: string };

/**
 * Split a bare sending mailbox into the parts the mode rules ask about.
 *
 * DELIBERATELY REFUSES THE DISPLAY-NAME FORM. `Acme <hello@acme.com>` is a
 * presentation concern set at send time (lib/email/sending-identity.ts
 * fromDisplayName), and storing it in this column has already cost this codebase
 * once: naively taking everything after the last "@" of a display-name string
 * yields `acme.com>` with the bracket attached, which produced a malformed
 * Message-Id on every send. This column holds the mailbox; the name is applied
 * by the send layer.
 *
 * Narrower than normalizeEmailAddress() in lib/client-automation-profiles.ts on
 * purpose, and not a duplicate of it: that one answers "can a small business
 * actually receive mail here" for CC and approver addresses, including the
 * typo'd-consumer-domain check. This one answers "is this the right mailbox for
 * the chosen mode", which is a different question about an address OASIS
 * operates. reply_from_identity had NO validation of either kind before this.
 */
function parseAddress(raw: unknown): ParsedAddress | { reason: string } {
  if (typeof raw !== "string") return { reason: "no sending address was given" };
  const value = raw.trim().toLowerCase();
  if (!value) return { reason: "the sending address is empty" };
  if (/[<>]/.test(value)) {
    return {
      reason:
        `"${raw.trim()}" carries a display name — store the bare mailbox ` +
        `(hello@example.com). The visible name is applied by the send layer, and a ` +
        `bracketed address here corrupts the Message-Id on every send`,
    };
  }
  if (value.length > 254) return { reason: "the sending address is longer than 254 characters" };
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) {
    return { reason: `"${raw.trim()}" is not an email address — it needs a mailbox and a domain` };
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64) return { reason: `"${raw.trim()}" has a local part longer than 64 characters` };
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) {
    return { reason: `"${raw.trim()}" has an unusable mailbox name` };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) {
    return { reason: `"${raw.trim()}" has an unusable domain` };
  }
  const plus = local.indexOf("+");
  return {
    address: value,
    local,
    base: plus < 0 ? local : local.slice(0, plus),
    tag: plus < 0 ? "" : local.slice(plus + 1),
    domain,
  };
}

/** The apex or any subdomain of it — never a lookalike that merely ends the same
 *  way, which is why this is not a bare `endsWith`. */
function isUnder(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/** The stored website_domain is already bare and normalized (the column's CHECK
 *  constraints enforce it). This only defends the hand-typed operator argument. */
function bareHost(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
}

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

export type ReplyIdentityResolution =
  | { ok: true; mode: ReplyIdentityMode; address: string; requiresDns: boolean }
  | { ok: false; error: string };

/**
 * Decide whether an address is a legal sending identity for a chosen mode.
 *
 * A MISSING MODE IS AN ERROR, NOT AN INVITATION TO GUESS. Every other branch in
 * this file exists so that a wrong pairing is caught here rather than by a
 * client's customers: an address on the wrong domain is not a cosmetic mismatch,
 * it is mail that fails SPF alignment and lands in spam, or worse, mail that
 * quietly borrows a reputation it was never granted.
 *
 * Every rejection names the specific mismatch and the mode that WOULD accept the
 * address, because the fix is almost always "you meant the other mode".
 */
export function resolveReplyIdentity(args: {
  mode: unknown;
  address: unknown;
  websiteDomain?: unknown;
}): ReplyIdentityResolution {
  const rawMode = typeof args.mode === "string" ? args.mode.trim() : "";
  if (!rawMode) {
    return {
      ok: false,
      error:
        `a reply identity mode is required — pass one of ${MODE_LIST} explicitly. ` +
        `There is no default: the choice decides whose sender reputation absorbs ` +
        `this client's spam complaints`,
    };
  }
  if (!isReplyIdentityMode(rawMode)) {
    return { ok: false, error: `reply identity mode "${rawMode}" is not one of ${MODE_LIST}` };
  }
  const mode = REPLY_IDENTITY_MODES[rawMode];

  const parsed = parseAddress(args.address);
  if ("reason" in parsed) return { ok: false, error: parsed.reason };

  const oasisOwned = isUnder(parsed.domain, OASIS_SENDING_DOMAIN);

  if (rawMode === "shared_oasis") {
    if (!oasisOwned) {
      return {
        ok: false,
        error:
          `shared_oasis needs an address on ${OASIS_SENDING_DOMAIN}, but "${parsed.address}" ` +
          `is on ${parsed.domain}. OASIS cannot send as a domain it does not control — ` +
          `use per_client_domain and verify that domain's DNS first`,
      };
    }
    if (parsed.tag) {
      return {
        ok: false,
        error:
          `"${parsed.address}" is a subaddress (+${parsed.tag}), which is per_client_subaddress, ` +
          `not shared_oasis. Storing it here would report shared reputation for a client that ` +
          `actually has its own analytics lane`,
      };
    }
  }

  if (rawMode === "per_client_subaddress") {
    if (!oasisOwned) {
      return {
        ok: false,
        error:
          `per_client_subaddress needs an address on ${OASIS_SENDING_DOMAIN}, but ` +
          `"${parsed.address}" is on ${parsed.domain}. Subaddressing only works on a domain ` +
          `OASIS controls — for the client's own domain use per_client_domain`,
      };
    }
    if (!parsed.tag) {
      return {
        ok: false,
        error:
          `per_client_subaddress needs a +tag identifying the client, e.g. ` +
          `${parsed.base}+acmehvac@${OASIS_SENDING_DOMAIN}. "${parsed.address}" has none, so ` +
          `every client's replies would land in one undifferentiated stream — that is shared_oasis`,
      };
    }
  }

  if (rawMode === "per_client_domain") {
    if (oasisOwned) {
      return {
        ok: false,
        error:
          `per_client_domain must send from the CLIENT's domain, but "${parsed.address}" is on ` +
          `${OASIS_SENDING_DOMAIN}. An OASIS address gets none of the isolation this mode is ` +
          `chosen for — use shared_oasis or per_client_subaddress`,
      };
    }
    const site = bareHost(args.websiteDomain);
    if (!site) {
      return {
        ok: false,
        error:
          `per_client_domain needs the client's registered website_domain to check ` +
          `"${parsed.address}" against — without it there is nothing proving OASIS may send ` +
          `as ${parsed.domain} at all`,
      };
    }
    if (!isUnder(parsed.domain, site)) {
      return {
        ok: false,
        error:
          `"${parsed.address}" is on ${parsed.domain}, which is not the client's domain ` +
          `(${site}). Sending as a third party's domain fails SPF alignment and borrows a ` +
          `reputation nobody granted`,
      };
    }
  }

  return { ok: true, mode: rawMode, address: parsed.address, requiresDns: mode.requiresClientDns };
}

// ---------------------------------------------------------------------------
// The activation gate
// ---------------------------------------------------------------------------

export type ActivationCheck = { ok: true } | { ok: false; error: string };

/**
 * May a profile on this mode go live?
 *
 * THE ONE RULE: per_client_domain sends as a domain OASIS does not own, so until
 * that domain publishes SPF, DKIM and DMARC pointing at the OASIS sender, every
 * message is unauthenticated mail claiming to be the client. Receivers either
 * junk it or start scoring the client's whole domain down — and the client, not
 * OASIS, is the one whose invoices and quotes stop arriving afterwards.
 *
 * Re-checked here even though migration 149 enforces it in the database, for the
 * reason activateClientAutomationProfile() already gives: a raw constraint
 * violation names a constraint, and this names the missing thing.
 */
export function canActivateProfile(args: {
  mode: unknown;
  dnsVerifiedAt: string | null | undefined;
}): ActivationCheck {
  if (!isReplyIdentityMode(args.mode)) {
    const shown = typeof args.mode === "string" && args.mode.trim() ? `"${args.mode.trim()}"` : "none";
    return {
      ok: false,
      error:
        `no usable reply identity mode on the profile (${shown}) — it must be one of ` +
        `${MODE_LIST} before the agent may send as this business`,
    };
  }
  if (REPLY_IDENTITY_MODES[args.mode].requiresClientDns && !args.dnsVerifiedAt?.trim()) {
    return {
      ok: false,
      error:
        `${args.mode} sends from the client's own domain, and its DNS has not been verified ` +
        `(dns_verified_at is empty) — publish SPF, DKIM and DMARC for the client's domain and ` +
        `record the verification first. Sending before that gets the client's domain blacklisted`,
    };
  }
  return { ok: true };
}
