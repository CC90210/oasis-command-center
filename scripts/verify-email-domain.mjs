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
 *   4. Is the suppression brand still pointed at a real tenant? This is the
 *      sharpest edge: get it wrong and new opt-outs record against a null tenant
 *      and are never honored, silently.
 *
 * Read-only. No writes, no sends, no secrets printed. Safe to run any time.
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
    try {
      const probe = await fetch(`${TRACKING.replace(/\/+$/, "")}/api/unsubscribe`, {
        method: "GET",
        redirect: "manual",
      });
      // Any real HTTP answer proves the host is attached to the app. A 404 means
      // it resolves but is serving something else (the marketing site).
      if (probe.status === 404) {
        bad(
          "Tracking host serves the app",
          `${host}/api/unsubscribe returned 404 — the host resolves but is NOT attached to this Vercel project, so unsubscribe links will be dead`,
        );
      } else {
        ok("Tracking host serves the app", `/api/unsubscribe answered ${probe.status}`);
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

warn(
  "Suppression brand",
  `set to "${BRAND}". This MUST match a row in tenants.name (ILIKE) or new unsubscribes record with tenant_id=NULL and are never honored. Verify against the database before go-live. Previously recorded suppressions are unaffected — enforcement keys on (tenant_id, email), not brand.`,
);

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
