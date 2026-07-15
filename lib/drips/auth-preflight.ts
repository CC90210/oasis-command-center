/**
 * lib/drips/auth-preflight.ts — turn the missing-DKIM config gap into a
 * self-guarding precondition. Before a REAL drip email, the engine checks the
 * sending domain's live SPF / DKIM / DMARC via DNS-over-HTTPS and acts on the
 * operator-chosen mode. So an unauthenticated blast can't silently torch
 * submissions@sunbizfunding.com's reputation — the system either refuses
 * (enforce) or shouts (warn).
 *
 * MODE (DRIP_AUTH_GATE, default "warn" per Adon 2026-07-14):
 *   warn    — send anyway, but flag it loudly (returns warn=true) until DKIM is
 *             fixed. Matches Adon's advisory-not-hard-gate preference.
 *   enforce — HOLD real email while DKIM is CONFIRMED missing.
 *   off     — no check.
 *
 * FAIL-SOFT: a DoH outage yields status "unknown" (dkim=null), which NEVER
 * blocks (even in enforce) — only a POSITIVE "DKIM absent" holds. A transient
 * resolver blip must not halt the funnel. Result is cached in-process for
 * AUTH_TTL_MS so we do at most one lookup per hour per warm Lambda.
 *
 * The manual fix (generate the DKIM key in Google Admin + publish 2 TXT
 * records) is a Conaugh/CC action — see docs/DKIM_DNS_HANDOFF_FOR_CC.md and
 * scripts/verify-email-auth.mjs.
 */

import "server-only";

export const SENDING_DOMAIN = (process.env.DRIP_SENDING_DOMAIN || "sunbizfunding.com").trim();
// Google Workspace default DKIM selector. Override if the Admin console used a
// custom selector when generating the key.
const DKIM_SELECTOR = (process.env.DRIP_DKIM_SELECTOR || "google").trim();
const AUTH_TTL_MS = 60 * 60 * 1000;

export type AuthGateMode = "warn" | "enforce" | "off";
export function authGateMode(): AuthGateMode {
  const m = (process.env.DRIP_AUTH_GATE || "warn").trim().toLowerCase();
  return m === "enforce" || m === "off" ? (m as AuthGateMode) : "warn";
}

export type EmailAuthStatus = {
  domain: string;
  spf: boolean | null; // null = couldn't resolve (unknown)
  dkim: boolean | null;
  dmarc: boolean | null;
  dmarcPolicy: string | null; // none | quarantine | reject | null
  checkedAt: number;
};

let cache: EmailAuthStatus | null = null;

/** One TXT lookup over DNS-over-HTTPS. Returns joined TXT strings (a single
 *  record can be chunked into multiple quoted segments — RFC 7208 — so we
 *  concatenate). Returns null on any resolver error/timeout (=> "unknown"). */
async function resolveTxt(name: string): Promise<string[] | null> {
  const endpoints = [
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
  ];
  for (const url of endpoints) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const json = (await res.json()) as { Answer?: Array<{ data?: string }> };
      const out: string[] = [];
      for (const a of json.Answer || []) {
        if (typeof a.data === "string") {
          // strip per-segment quotes and join chunks: "seg1" "seg2" -> seg1seg2
          out.push(a.data.replace(/"\s*"/g, "").replace(/^"|"$/g, ""));
        }
      }
      return out;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

function hasToken(records: string[] | null, token: RegExp): boolean | null {
  if (records === null) return null; // unknown (resolver failed)
  return records.some((r) => token.test(r));
}

/** Live SPF/DKIM/DMARC status for the sending domain, cached AUTH_TTL_MS.
 *  Pass force=true (e.g. from the verify script) to bypass the cache. */
export async function getEmailAuthStatus(force = false): Promise<EmailAuthStatus> {
  if (!force && cache && Date.now() - cache.checkedAt < AUTH_TTL_MS) return cache;

  const [spfRec, dkimRec, dmarcRec] = await Promise.all([
    resolveTxt(SENDING_DOMAIN),
    resolveTxt(`${DKIM_SELECTOR}._domainkey.${SENDING_DOMAIN}`),
    resolveTxt(`_dmarc.${SENDING_DOMAIN}`),
  ]);

  let dmarcPolicy: string | null = null;
  if (dmarcRec) {
    const rec = dmarcRec.find((r) => /v=DMARC1/i.test(r));
    const m = rec?.match(/p=\s*(none|quarantine|reject)/i);
    dmarcPolicy = m ? m[1].toLowerCase() : null;
  }

  cache = {
    domain: SENDING_DOMAIN,
    spf: hasToken(spfRec, /v=spf1/i),
    dkim: hasToken(dkimRec, /v=DKIM1|k=rsa|p=[A-Za-z0-9+/]/i),
    dmarc: hasToken(dmarcRec, /v=DMARC1/i),
    dmarcPolicy,
    checkedAt: Date.now(),
  };
  return cache;
}

export type AuthDecision = { block: boolean; warn: boolean; reason: string; status: EmailAuthStatus };

/** No-op decision for a dispatch batch with zero email rows — avoids a DoH
 *  lookup when nothing this run needs it. */
export function skipAuthDecision(): AuthDecision {
  return {
    block: false,
    warn: false,
    reason: "no_email_rows",
    status: { domain: SENDING_DOMAIN, spf: null, dkim: null, dmarc: null, dmarcPolicy: null, checkedAt: Date.now() },
  };
}

/** Decide what to do with a real email send given the live auth status + mode.
 *  Only a POSITIVE "DKIM confirmed absent" (dkim === false) ever blocks/warns —
 *  unknown (null, resolver down) is treated as pass so a DoH blip can't halt
 *  the funnel. */
export async function emailAuthDecision(): Promise<AuthDecision> {
  const mode = authGateMode();
  const status = await getEmailAuthStatus();
  if (mode === "off") return { block: false, warn: false, reason: "gate_off", status };

  const dkimMissing = status.dkim === false;
  const spfMissing = status.spf === false;
  const problems: string[] = [];
  if (dkimMissing) problems.push("DKIM_absent");
  if (spfMissing) problems.push("SPF_absent");

  if (problems.length === 0) return { block: false, warn: false, reason: "auth_ok_or_unknown", status };

  const reason = problems.join(",");
  return mode === "enforce"
    ? { block: true, warn: false, reason, status }
    : { block: false, warn: true, reason, status };
}
