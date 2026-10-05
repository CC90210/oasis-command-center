#!/usr/bin/env node
/**
 * scripts/consent_capture_canary.mjs — is consent evidence ACTUALLY being
 * sealed for the merchants filling in the live application right now?
 *
 * WHY THIS EXISTS
 * On 2026-09-14 a merchant smoke test found that no SunBiz consent had been
 * captured at all. The capture site's `form_url_pattern` named a host merchants
 * no longer landed on, so every capture was refused `422 form_url_mismatch` —
 * and because the vault omitted CORS headers on error responses, the browser
 * could only report "blocked by CORS policy". The form showed the disclosure,
 * the merchant agreed, `captureConsent` soft-failed by design, and the evidence
 * was never written. Nothing alerted, because nothing was broken in a way
 * anything watched.
 *
 * The soft-fail is correct: a merchant's funding enquiry must not die because
 * our bookkeeping did. But a soft-fail nobody can see is how months of consent
 * evidence go missing. This is the thing that watches.
 *
 * WHAT IT CHECKS, and why it is not "does the endpoint respond"
 * `form_url` must match the capture site's pattern, and that pattern names ONE
 * origin. Every hostname change on the merchant's journey — a new custom
 * domain, a changed redirect, a different Vercel alias — silently invalidates
 * it. So the canary asks the question that actually matters: taking the URL a
 * merchant is redirected to TODAY, would a capture from that page be sealed?
 *
 * It is read-only against production. It sends NO consent record: a HEAD-like
 * probe with a deliberately invalid payload distinguishes "this origin and
 * form_url would be accepted" from "this one is refused, and here is the code",
 * without writing evidence for a person who does not exist.
 *
 * BLOCKED vs FAILED
 * A refused capture is BLOCKED — a human must fix a pattern or a hostname, and
 * retrying will never help. Exit 0 so a caller escalates ONCE. A network fault
 * is FAILED, exit 1, because retrying is meaningful.
 *
 * Usage:
 *   node scripts/consent_capture_canary.mjs
 *   node scripts/consent_capture_canary.mjs --json
 */

const JSON_OUT = process.argv.includes("--json");
const VAULT = process.env.NEXT_PUBLIC_OPTINVAULT_URL || "https://opt-in-vault.vercel.app";
const DISCLOSURE = process.env.NEXT_PUBLIC_OPTINVAULT_DISCLOSURE_SUNBIZ || "sunbiz-v1-2026-08";
// Publishable by design — it ships in the client bundle of every public form.
const SITE_KEY = process.env.NEXT_PUBLIC_OPTINVAULT_SITE_KEY_SUNBIZ || "";

/** The doors a merchant is actually handed. */
const DOORS = ["https://sunbizfunding.com/start", "https://www.sunbizfunding.com/start"];

const results = [];

/** Where does this door actually put the merchant? */
async function resolveLanding(door) {
  const r = await fetch(door, { redirect: "follow" });
  return { status: r.status, url: r.url };
}

/**
 * Would a capture from this page actually be SEALED?
 *
 * This sends a REAL, complete capture, because nothing weaker tests the thing
 * that broke. The vault validates the schema before it ever compares
 * `form_url`, so a deliberately-malformed probe is refused early and tells us
 * nothing about the pattern — a check that cannot fail on the original defect
 * is not a check.
 *
 * It is safe to run repeatedly because the IDEMPOTENCY KEY IS STABLE. The first
 * run seals exactly one record for a clearly-labelled canary identity; every
 * run after that returns that same record with `created:false`. The vault
 * accumulates one permanent synthetic fixture, not one per execution — which is
 * what docs/BUILD_ACCEPTANCE_STANDARD.md asks for.
 */
const CANARY_EMAIL = "consent-canary@sunbizfunding.com";  // owner-controlled domain
const CANARY_PHONE = "+13055550100";                       // reserved fictional range
const IDEMPOTENCY = "sunbiz-consent-canary-v1";            // STABLE, on purpose

async function probe(origin, formUrl, siteKey) {
  const r = await fetch(`${VAULT}/api/v1/consent/log`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "idempotency-key": IDEMPOTENCY,
      ...(siteKey ? { "x-optinvault-site-key": siteKey } : {}),
    },
    body: JSON.stringify({
      disclosure_version: DISCLOSURE,
      affirmative_action: "form_submit",
      form_url: formUrl,
      email: CANARY_EMAIL,
      phone: CANARY_PHONE,
    }),
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return {
    status: r.status,
    acao: r.headers.get("access-control-allow-origin"),
    error: body?.error ?? null,
    consentId: body?.consent_id ?? null,
    created: body?.created ?? null,
  };
}

for (const door of DOORS) {
  const row = { door };
  try {
    const landing = await resolveLanding(door);
    row.landing = landing.url;
    const origin = new URL(landing.url).origin;

    const res = await probe(origin, landing.url, SITE_KEY);
    row.status = res.status;
    row.error = res.error;

    // 1. Can the browser READ the vault's answer at all? Without this header a
    //    refusal is invisible to the only client that can act on it.
    if (!res.acao) {
      row.verdict = "BLOCKED";
      row.detail =
        "the vault answered without access-control-allow-origin, so a merchant's browser cannot read this response — any refusal will surface only as an opaque CORS error";
      results.push(row);
      continue;
    }

    // 2. Is the refusal about our CONFIGURATION rather than the missing key?
    //    form_url/origin/disclosure are checked against the capture site, and a
    //    mismatch means live captures are being thrown away.
    if (["form_url_mismatch", "origin_not_allowed", "disclosure_mismatch", "site_inactive"].includes(res.error)) {
      row.verdict = "BLOCKED";
      row.detail =
        `the vault refuses captures from where merchants actually land (${res.error}). Consent evidence is NOT being recorded. Fix the capture site's configuration for origin ${origin}`;
      results.push(row);
      continue;
    }

    // 3. The whole point: was evidence actually SEALED? 201 = the canary record
    //    was created on this run, 200 with created:false = the stable
    //    idempotency key returned the one that already exists. Anything else is
    //    not a capture, whatever the status code says.
    if ((res.status === 201 || res.status === 200) && res.consentId) {
      row.verdict = "OK";
      row.consent_id = res.consentId;
      row.detail = `consent SEALED from ${origin} (${res.created ? "created" : "idempotent replay of the permanent canary record"})`;
    } else if (res.error === "site_not_found" && !SITE_KEY) {
      // Without the publishable key this cannot test the pattern at all, and
      // saying OK here would be the precise mistake this canary exists to stop.
      row.verdict = "BLOCKED";
      row.detail =
        "NEXT_PUBLIC_OPTINVAULT_SITE_KEY_SUNBIZ is not set, so this run could not test whether a real capture would be accepted. Set it (it is publishable) and re-run";
    } else {
      row.verdict = "BLOCKED";
      row.detail = `the vault did not seal a record: ${res.status}${res.error ? ` (${res.error})` : ""}. Consent evidence is NOT being recorded for merchants landing on ${origin}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    row.verdict = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(msg) ? "BLOCKED" : "FAILED";
    row.detail = msg;
  }
  results.push(row);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  for (const r of results) {
    const tag = r.verdict === "OK" ? "OK     " : r.verdict === "BLOCKED" ? "BLOCKED" : "FAILED ";
    console.log(`${tag} ${r.door}`);
    console.log(`        lands on: ${r.landing ?? "-"}`);
    console.log(`        ${r.detail}`);
  }
}

const failed = results.filter((r) => r.verdict === "FAILED");
const blocked = results.filter((r) => r.verdict === "BLOCKED");
if (failed.length) {
  console.error(`\n${failed.length} FAILED — could not reach the consent vault.`);
  process.exit(1);
}
if (blocked.length) {
  console.error(`\n${blocked.length} BLOCKED — a human must act. Consent evidence is not being sealed for live merchants:`);
  for (const b of blocked) console.error(`  - ${b.door} -> ${b.landing}: ${b.detail}`);
  process.exit(0);
}
console.log(`\nAll ${results.length} merchant doors would have their consent sealed.`);
