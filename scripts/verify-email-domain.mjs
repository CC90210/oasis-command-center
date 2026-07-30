#!/usr/bin/env node
/**
 * verify-email-domain.mjs — preflight for an outbound email domain cutover.
 *
 * Run this BEFORE pointing drips at a new sending domain (the Bluerise Business
 * Capital move, 2026-08). It answers the questions that are expensive to get
 * wrong and invisible until merchants stop receiving mail:
 *
 *   1. Is the sending domain authenticated (SPF, DKIM, DMARC)? Sending from an
 *      unauthenticated domain during warmup is how a new domain gets burned.
 *   2. Do the tracking links actually align with the visible sender, or is the
 *      old mismatch simply rebuilt under a new brand?
 *   3. Does the tracking host resolve, and does it serve the app? A tracking
 *      host that does not reach the app means a dead unsubscribe link, which is
 *      a compliance failure rather than a cosmetic one.
 *   4. Is the suppression brand safe? This script has NO database access by
 *      design (no dependencies, no secrets), so it does not claim to resolve the
 *      tenant. It fails closed on any value it cannot vouch for and requires
 *      --suppression-verified to accept a changed one. Get this wrong and new
 *      opt-outs record against a null tenant and are silently never honored.
 *
 * SIDE EFFECTS, stated precisely rather than as a blanket "read-only" claim:
 *   - No email is sent. No suppression is ever recorded. No secrets printed.
 *   - The unsubscribe probe deliberately takes the `invalid_json` branch, which
 *     returns before any write.
 *   - ONE residual: if the source IP is ALREADY rate-limited, /api/unsubscribe
 *     records a single `rate_limited` attempt before it parses the body. That
 *     needs the IP to be over the limit already, so it cannot happen from a
 *     normal preflight; it is documented rather than engineered around because
 *     the alternative is a dedicated health endpoint for one probe.
 *   Safe to run any time. Do not run it in a tight loop.
 *
 * Usage:
 *   node scripts/verify-email-domain.mjs
 *   node scripts/verify-email-domain.mjs --from ops@bluerisebusinesscapital.com \
 *        --tracking https://go.bluerisebusinesscapital.com \
 *        --intake https://bluerisebusinesscapital.com/apply
 *
 * Flags override the environment, so a cutover can be rehearsed from a laptop
 * that does not hold the production configuration.
 *
 * Exit codes: 0 all good, 1 at least one FAIL, 2 the script itself broke
 * (never report a broken checker as a pass).
 */

import { resolveTxt } from "node:dns/promises";

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

const FROM = flag("from") || process.env.DRIP_FROM_ADDRESS || "submissions@sunbizfunding.com";
const TRACKING = flag("tracking") || process.env.DRIP_TRACKING_BASE_URL || "";
const INTAKE = flag("intake") || process.env.DRIP_INTAKE_URL || "";
const BRAND = flag("brand") || process.env.DRIP_SUPPRESSION_BRAND || "SunBiz";
const DKIM_SELECTOR = flag("selector") || "google";

const results = [];
const ok = (label, detail) => results.push({ level: "PASS", label, detail });
const warn = (label, detail) => results.push({ level: "WARN", label, detail });
const bad = (label, detail) => results.push({ level: "FAIL", label, detail });

function domainOf(addr) {
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : "";
}

async function txt(name) {
  try {
    const rows = await resolveTxt(name);
    return rows.map((r) => (Array.isArray(r) ? r.join("") : String(r)));
  } catch {
    return [];
  }
}

const sendingDomain = domainOf(FROM);
if (!sendingDomain) {
  console.error(`[verify-email-domain] cannot parse a domain out of From: ${FROM}`);
  process.exit(2);
}

// ── 1. Authentication on the sending domain ─────────────────────────────────

const rootTxt = await txt(sendingDomain);
const spf = rootTxt.find((r) => r.toLowerCase().startsWith("v=spf1"));
if (spf) ok("SPF", spf);
else bad("SPF", `no v=spf1 record on ${sendingDomain}`);

const dkimTxt = await txt(`${DKIM_SELECTOR}._domainkey.${sendingDomain}`);
const dkim = dkimTxt.find((r) => r.toLowerCase().includes("v=dkim1"));
if (dkim) ok("DKIM", `selector "${DKIM_SELECTOR}" published (${dkim.length} chars)`);
else bad("DKIM", `no DKIM record at ${DKIM_SELECTOR}._domainkey.${sendingDomain}`);

const dmarcTxt = await txt(`_dmarc.${sendingDomain}`);
const dmarc = dmarcTxt.find((r) => r.toLowerCase().startsWith("v=dmarc1"));
if (!dmarc) {
  bad("DMARC", `no _dmarc record on ${sendingDomain}`);
} else {
  const policy = /p=([a-z]+)/i.exec(dmarc)?.[1] || "none";
  const hasRua = /rua=/i.test(dmarc);
  if (!hasRua) {
    warn("DMARC", `published (p=${policy}) but NO rua= — you get no aggregate reports, so auth failures are invisible`);
  } else {
    ok("DMARC", `p=${policy}, rua present`);
  }
}

// ── 2. Do the links align with the visible sender? ──────────────────────────

if (!TRACKING) {
  warn(
    "Link alignment",
    `DRIP_TRACKING_BASE_URL unset — tracking, unsubscribe and per-lead links stay on the platform origin while mail is From ${FROM}. This is the pre-cutover state, not an error.`,
  );
} else {
  let host = "";
  try {
    const u = new URL(TRACKING);
    if (u.protocol !== "https:") {
      bad("Tracking origin", `must be https, got ${u.protocol}//`);
    } else {
      host = u.hostname.toLowerCase();
    }
  } catch {
    bad("Tracking origin", `not a valid URL: ${TRACKING}`);
  }
  if (host) {
    const aligned = host === sendingDomain || host.endsWith(`.${sendingDomain}`);
    if (aligned) ok("Link alignment", `${host} is on the sending domain ${sendingDomain}`);
    else
      bad(
        "Link alignment",
        `tracking host ${host} is NOT on the sending domain ${sendingDomain} — this rebuilds the exact mismatch the cutover exists to remove`,
      );

    // Does that host actually reach the app? A tracking host that does not serve
    // the app means a dead unsubscribe link.
    // Probe the OPEN PIXEL, not /api/unsubscribe: that route exports POST only,
    // so a GET gets Next's framework method-not-allowed page and this check would
    // fail against the genuine app (Codex review P1). The pixel route is GET,
    // always answers with a 1x1 image/gif regardless of whether the id resolves,
    // and is harmless to hit — and it is the endpoint that actually has to work
    // from the tracking host.
    try {
      const probe = await fetch(
        `${TRACKING.replace(/\/+$/, "")}/api/track/open/preflight-probe-no-such-send`,
        { method: "GET", redirect: "manual" },
      );
      // Any real HTTP answer proves the host is attached to the app. A 404 means
      // it resolves but is serving something else (the marketing site).
      // Assert an APP-SPECIFIC response, not merely "not a 404". A marketing site
      // with a catch-all route happily returns 200 for unknown paths, and a
      // generic error page or a redirect would sail past a not-404 check while
      // tracking and unsubscribe links were dead (Codex review P2).
      //
      // The pixel route answers 200 with content-type image/gif and a tiny body.
      // A catch-all HTML page cannot fake that.
      const ct = (probe.headers.get("content-type") || "").toLowerCase();
      const isGif = probe.status === 200 && ct.includes("image/gif");
      const pixelDetail = `status ${probe.status}, content-type ${ct || "(none)"}`;

      // The pixel proves TRACKING works from this host. It does NOT prove
      // /api/unsubscribe is there — an older deployment or a path-based proxy
      // could serve one and not the other, and this preflight explicitly
      // certifies unsubscribe availability (Codex review P2). So probe both.
      //
      // POST is the unsubscribe route's only method, and the BODY MATTERS for
      // keeping this script's read-only promise honest (Codex review P2).
      //
      // A well-formed `{}` reaches the invalid_email branch, which calls
      // recordPairAttempt — inserting a pair_attempts row and counting against
      // the IP rate limiter, so repeated preflights could 429 a real merchant's
      // unsubscribe. A deliberately MALFORMED body short-circuits earlier, at
      // `catch { return bad(400, "invalid_json") }`, which writes nothing at all.
      //
      // Same fingerprint ({ok:false} JSON that only this app produces), zero
      // side effects.
      let unsubOk = false;
      let unsubDetail = "not attempted";
      try {
        const u = await fetch(`${TRACKING.replace(/\/+$/, "")}/api/unsubscribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "preflight-probe-not-json",
          redirect: "manual",
        });
        const uct = (u.headers.get("content-type") || "").toLowerCase();
        unsubDetail = `status ${u.status}, content-type ${uct || "(none)"}`;
        if (uct.includes("application/json")) {
          const body = await u.json().catch(() => null);
          // Any JSON carrying `ok` is this app's handler. A 429 counts: being
          // rate-limited still proves the route exists and is ours.
          unsubOk = Boolean(body && typeof body === "object" && "ok" in body);
          if (unsubOk) unsubDetail += `, ok=${JSON.stringify(body.ok)}`;
        }
      } catch (e) {
        unsubDetail = `unreachable: ${e instanceof Error ? e.message : "unknown"}`;
      }

      if (isGif && unsubOk) {
        ok("Tracking host serves the app", `open pixel (${pixelDetail}); unsubscribe (${unsubDetail})`);
      } else if (!isGif) {
        bad(
          "Tracking host serves the app",
          `${host}/api/track/open/... did not answer like this app (${pixelDetail}). The host resolves but is serving something else, most likely the marketing site, so tracking links will be dead.`,
        );
      } else {
        bad(
          "Unsubscribe reachable on tracking host",
          `${host} serves the tracking pixel but /api/unsubscribe did not answer like this app (${unsubDetail}). Every unsubscribe link in that mail would be dead, which is a compliance failure, not a cosmetic one.`,
        );
      }
    } catch (e) {
      bad(
        "Tracking host serves the app",
        `could not reach ${host}: ${e instanceof Error ? e.message : "unknown"} (DNS not propagated, or not added to the project yet)`,
      );
    }
  }
}

// ── 3. CTA destination ──────────────────────────────────────────────────────

if (!INTAKE) {
  warn("CTA destination", "DRIP_INTAKE_URL unset — the generic apply link falls back to the platform origin");
} else {
  try {
    const u = new URL(INTAKE);
    if (u.protocol !== "https:") bad("CTA destination", `must be https, got ${INTAKE}`);
    else ok("CTA destination", u.href);
  } catch {
    bad("CTA destination", `not a valid URL: ${INTAKE}`);
  }
}

// ── 4. Suppression brand ────────────────────────────────────────────────────
// This one cannot be checked from DNS. It is stated loudly instead, because it
// is the failure that is both silent and legally serious.

// This script has no database access by design (no deps, no secrets). So it does
// not CLAIM to resolve the tenant — it fails closed on any value it cannot vouch
// for, and requires a human to assert the lookup was done.
//
// "SunBiz" is the known-good value currently in production, so it passes. Any
// other value is treated as unproven and FAILS until --suppression-verified is
// passed, because the failure it guards is silent and legally serious: a brand
// matching no tenant records opt-outs with tenant_id=NULL, and
// checkEmailSuppressed filters on tenant_id, so those unsubscribes are never
// honored (Codex review P1 — this used to warn and still exit 0).
const KNOWN_GOOD_BRAND = "SunBiz";
const brandVerified = argv.includes("--suppression-verified");
if (BRAND === KNOWN_GOOD_BRAND) {
  ok("Suppression brand", `"${BRAND}" is the known-good production value`);
} else if (brandVerified) {
  ok(
    "Suppression brand",
    `"${BRAND}" accepted on your explicit assertion that it matches a tenants.name row`,
  );
} else {
  bad(
    "Suppression brand",
    `"${BRAND}" is not the known-good value and cannot be verified from here. Confirm it matches a row in tenants.name (ILIKE), then re-run with --suppression-verified. If it matches nothing, every NEW unsubscribe records against tenant_id=NULL and is silently ignored. Suppressions recorded BEFORE the change keep working, since enforcement keys on (tenant_id, email).`,
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
console.log(`\nOutbound email preflight\n${"=".repeat(60)}`);
console.log(`From:            ${FROM}`);
console.log(`Sending domain:  ${sendingDomain}`);
console.log(`Tracking origin: ${TRACKING || "(unset — platform origin)"}`);
console.log(`CTA destination: ${INTAKE || "(unset — platform origin)"}`);
console.log(`${"=".repeat(60)}\n`);

for (const r of results) {
  const mark = r.level === "PASS" ? "  ok  " : r.level === "WARN" ? " warn " : " FAIL ";
  console.log(`[${mark}] ${pad(r.label, 28)} ${r.detail}`);
}

const failures = results.filter((r) => r.level === "FAIL").length;
const warnings = results.filter((r) => r.level === "WARN").length;
console.log(
  `\n${results.length - failures - warnings} passed, ${warnings} warnings, ${failures} failures\n`,
);
process.exit(failures > 0 ? 1 : 0);
