#!/usr/bin/env node
/**
 * verify-email-auth.mjs — one-command SPF / DKIM / DMARC health check for the
 * drip sending domain. No deps, no secrets — pure public DNS-over-HTTPS.
 *
 *   node scripts/verify-email-auth.mjs                       # sunbizfunding.com
 *   node scripts/verify-email-auth.mjs sunbizfunding.com google
 *
 * Exit code 0 = all green, 1 = something needs fixing. Hand this to whoever
 * owns DNS so they can confirm the DKIM/DMARC records landed. Mirrors the live
 * check lib/drips/auth-preflight.ts runs before every real drip email.
 */

const domain = (process.argv[2] || "sunbizfunding.com").trim();
const selector = (process.argv[3] || "google").trim();

async function txt(name) {
  for (const url of [
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
  ]) {
    try {
      const res = await fetch(url, { headers: { accept: "application/dns-json" } });
      if (!res.ok) continue;
      const json = await res.json();
      return (json.Answer || [])
        .map((a) => (typeof a.data === "string" ? a.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "") : ""))
        .filter(Boolean);
    } catch {
      /* next resolver */
    }
  }
  return null; // resolver failure (unknown, not "absent")
}

const mark = (ok) => (ok === true ? "PASS " : ok === false ? "FAIL " : "?    ");

async function main() {
  console.log(`\nEmail auth check — ${domain} (DKIM selector: ${selector})\n${"-".repeat(52)}`);

  const spfRec = await txt(domain);
  const spf = spfRec === null ? null : spfRec.some((r) => /v=spf1/i.test(r));
  const spfHasGoogle = (spfRec || []).some((r) => /include:_spf\.google\.com/i.test(r));
  console.log(`${mark(spf)} SPF        ${spf ? (spfHasGoogle ? "present, includes Google" : "present (no Google include!)") : "MISSING"}`);

  const dkimRec = await txt(`${selector}._domainkey.${domain}`);
  const dkim = dkimRec === null ? null : dkimRec.some((r) => /v=DKIM1|k=rsa|p=[A-Za-z0-9+/]/i.test(r));
  console.log(`${mark(dkim)} DKIM       ${dkim ? "present" : dkim === false ? "MISSING — generate in Google Admin + publish TXT" : "unresolved (DNS error)"}`);

  const dmarcRec = await txt(`_dmarc.${domain}`);
  const dmarc = dmarcRec === null ? null : dmarcRec.some((r) => /v=DMARC1/i.test(r));
  const pol = (dmarcRec || []).map((r) => r.match(/p=\s*(none|quarantine|reject)/i)?.[1]).find(Boolean) || null;
  const rua = (dmarcRec || []).some((r) => /rua=/i.test(r));
  console.log(`${mark(dmarc)} DMARC      ${dmarc ? `present (p=${pol || "?"}${rua ? ", reporting on" : ", NO rua reporting"})` : "MISSING"}`);

  const allGreen = spf === true && dkim === true && dmarc === true;
  console.log(`${"-".repeat(52)}`);
  console.log(allGreen ? "ALL GREEN — safe to ramp drip email.\n" : "NOT READY — see docs/DKIM_DNS_HANDOFF_FOR_CC.md.\n");
  process.exit(allGreen ? 0 : 1);
}

main().catch((e) => {
  console.error("verify failed:", e);
  process.exit(1);
});
