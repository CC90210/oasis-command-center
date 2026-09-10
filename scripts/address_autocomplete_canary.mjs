#!/usr/bin/env node
/**
 * scripts/address_autocomplete_canary.mjs — does the LIVE merchant address
 * field actually work, right now, on the hosts merchants use?
 *
 * WHY THIS EXISTS
 * On 2026-09-10 the merchant application's address field had been quietly
 * broken since launch. `GOOGLE_PLACES_API_KEY` had never been set on the Vercel
 * project at all, so every request fell through the provider ladder to the
 * keyless Photon/OSM fallback. Nothing failed. `ok:true` came back every time,
 * with a full dropdown of confident, wrong suggestions: 26 of 56 dropped the
 * house number the merchant had typed, counties were printed as cities, and
 * some carried no ZIP, so selecting one from our own dropdown was then refused
 * by our own gate with no way out.
 *
 * That is the failure this repo already has a name for: redundancy hides
 * failure. A fallback made a dead provider look healthy. So the check here is
 * NOT "does the endpoint respond" — it responded perfectly for months. It is
 * "did the provider we intend actually CONTRIBUTE, and is what it returned
 * something a merchant can submit".
 *
 * BLOCKED vs FAILED
 * A missing/dead key is BLOCKED: a human must set it, retrying will never help.
 * Exit 0 with a blocked verdict so a caller escalates ONCE instead of alerting
 * forever. A network/HTTP fault is FAILED: exit 1, retry is meaningful.
 *
 * Usage:
 *   node scripts/address_autocomplete_canary.mjs
 *   node scripts/address_autocomplete_canary.mjs --host https://apply.sunbizfunding.com
 *   node scripts/address_autocomplete_canary.mjs --json
 */

import { isAcceptableCaptureAddress } from "../lib/address/us-address.ts";

const HOSTS = process.argv.includes("--host")
  ? [process.argv[process.argv.indexOf("--host") + 1]]
  : ["https://sunbizfunding.com", "https://apply.sunbizfunding.com", "https://oasisai.work"];

const JSON_OUT = process.argv.includes("--json");

// Real, unambiguous US addresses. If a provider cannot resolve these it is not
// serving merchants either.
const PROBES = [
  { q: "911 Magnolia Dr Algonquin", expectHouseNumber: "911" },
  { q: "350 5th Ave New York", expectHouseNumber: "350" },
  { q: "1 Infinite Loop Cupertino", expectHouseNumber: "1" },
];

const results = [];

for (const host of HOSTS) {
  for (const probe of PROBES) {
    const row = { host, q: probe.q };
    try {
      const res = await fetch(
        `${host}/api/forms/address-autocomplete?q=${encodeURIComponent(probe.q)}`,
        { redirect: "follow" },
      );
      row.http = res.status;
      if (!res.ok) {
        row.verdict = "FAILED";
        row.detail = `HTTP ${res.status}`;
        results.push(row);
        continue;
      }
      const data = await res.json();
      row.provider = data.provider ?? "(field absent — deployment predates the provider signal)";
      const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      row.count = suggestions.length;

      if (suggestions.length === 0) {
        row.verdict = "BLOCKED";
        row.detail = "no suggestions — every provider in the ladder is down or unconfigured";
        results.push(row);
        continue;
      }

      // 1. Did the intended provider contribute? Photon is the last resort, not
      //    the product. Seeing it here means Google is missing or dead.
      if (data.provider === "photon") {
        row.verdict = "BLOCKED";
        row.detail =
          "served by the keyless OSM fallback — GOOGLE_PLACES_API_KEY is unset or rejected on this deployment";
        results.push(row);
        continue;
      }

      // 2. Would every suggestion actually survive our own capture gate? A
      //    dropdown entry our validator refuses is a dead end for the merchant.
      const refused = suggestions.filter((s) => !isAcceptableCaptureAddress(s.value ?? s).ok);
      // 3. Did any suggestion silently drop the house number the merchant typed?
      //    Google returns its label without a ZIP, so a placeId (resolvable on
      //    select) counts as complete; only an UNRESOLVABLE bad entry is a fault.
      const lostNumber = suggestions.filter(
        (s) => !String(s.value ?? s).trim().startsWith(probe.expectHouseNumber) && !s.placeId,
      );

      row.refused = refused.length;
      row.lost_house_number = lostNumber.length;

      if (refused.length && !suggestions.every((s) => s.placeId)) {
        row.verdict = "FAILED";
        row.detail = `${refused.length}/${suggestions.length} suggestions would be refused by our own gate, e.g. "${refused[0].value ?? refused[0]}"`;
      } else if (lostNumber.length) {
        row.verdict = "FAILED";
        row.detail = `${lostNumber.length}/${suggestions.length} suggestions dropped the merchant's house number, e.g. "${lostNumber[0].value ?? lostNumber[0]}"`;
      } else {
        row.verdict = "OK";
        row.detail = `${suggestions.length} usable suggestions from ${data.provider}`;
      }
    } catch (err) {
      // A host that does not resolve at all is not a flaky request — it is a
      // domain nobody has pointed anywhere, and no amount of retrying fixes it.
      // Live example, 2026-09-10: apply.sunbizfunding.com is attached to the
      // Vercel project `agent-dashboard` and has NO DNS record (ENOTFOUND), so
      // any merchant link built on that host dies before it reaches us. That is
      // BLOCKED — a human sets the record or detaches the domain.
      const msg = err instanceof Error ? err.message : String(err);
      const unreachable = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(msg);
      row.verdict = unreachable ? "BLOCKED" : "FAILED";
      row.detail = unreachable
        ? `host unreachable (${msg}) — no DNS record, or the domain is attached in Vercel but never pointed`
        : msg;
    }
    results.push(row);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  for (const r of results) {
    const tag = r.verdict === "OK" ? "OK     " : r.verdict === "BLOCKED" ? "BLOCKED" : "FAILED ";
    console.log(`${tag} ${r.host}  "${r.q}"  provider=${r.provider ?? "-"}  ${r.detail}`);
  }
}

const failed = results.filter((r) => r.verdict === "FAILED");
const blocked = results.filter((r) => r.verdict === "BLOCKED");

if (failed.length) {
  console.error(`\n${failed.length} FAILED — the live address field is serving merchants bad suggestions.`);
  process.exit(1);
}
if (blocked.length) {
  // BLOCKED is not FAIL: a human must act, and retrying will never help. Exit 0
  // so the caller escalates ONCE rather than alerting forever. A non-zero code
  // here would mean "retry me" and repeat until someone muted it.
  // (See memory: blocking-is-not-an-error.)
  console.error(`\n${blocked.length} BLOCKED — a human must act:`);
  for (const b of blocked) console.error(`  - ${b.host} "${b.q}": ${b.detail}`);
  process.exit(0);
}
console.log(`\nAll ${results.length} probes OK.`);
