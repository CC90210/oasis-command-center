/**
 * lib/drips/rep-sms-identity.ts — resolve which TextTorrent sub-account + number
 * a drip SMS to one lead goes out on, based on the lead's assigned rep.
 *
 * Per Adon (2026-07-09): drip SMS must send from the LEAD REP'S own TextTorrent
 * account, not one shared line —
 *   Alex's leads   → act-as alex@sunbizfunding.com   (Alex's sub-account)
 *   Jordan's leads → act-as jordan@sunbizfunding.com (Jordan's sub-account)
 *   Matt / owner   → the ADMIN (parent) account itself, NO act-as
 *   Solara / none / unknown → admin (fail-safe: the owner catches unattributed)
 *
 * Sub-account act-as ONLY works on the MAIN "texttorrent" account — the parent
 * SID that owns the sub-accounts — NOT the dedicated "texttorrent_followup"
 * account (a different SID with no sub-accounts). So every per-rep drip SMS
 * authenticates on the main account. The identities + numbers below are VERIFIED
 * against the live TT API (GET /inbox/numbers/active per act-as, 2026-07-09).
 *
 * Numbers get carrier-burned + rotated, so the whole registry is overridable at
 * runtime via the DRIP_REP_SMS_IDENTITIES env var (JSON) — rotate a number or
 * add a rep without a redeploy. A malformed/partial override FAILS CLOSED to the
 * verified built-in defaults (never to an empty or silently-shared identity).
 *
 * Every act-as email + sender number is charset-allowlisted before it can reach
 * an HTTP request header (X-ACT-AS-USER) or the send body (sender_id) —
 * encodeURIComponent alone is insufficient for those contexts. See
 * [[argv-for-path-handling]].
 */

import "server-only";
import { resolveTextTorrentSenderId } from "@/lib/integrations/texttorrent-sender";
import { getServiceSupabase } from "@/lib/supabase-server";
import { liveNumbersFor } from "@/lib/drips/sender-sync";
import { classifyRep, actAsEmailForRep } from "./rep-keys";
import { chooseLine } from "./rep-line-core";
export { classifyRep };

export type DripSmsIdentity = {
  /** X-ACT-AS-USER sub-account email, or null to send as the parent/admin account. */
  actAsEmail: string | null;
  /** The sending DID (E.164). */
  senderId: string;
  /** Short, stable label for from_identity logging + attribution ("alex"/"jordan"/"admin"). */
  repKey: string;
};

type RepEntry = { actAs: string | null; numbers: string[] };

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const E164_RE = /^\+[1-9][0-9]{9,14}$/;

// VERIFIED live 2026-07-09 (GET /inbox/numbers/active per act-as on the main SID).
//  - jordan: the spammy +18604527608 is INTENTIONALLY dropped (outreach-intel
//    flag "rotate it"); re-add via env once it cools off. Only +13106271134 here.
//  - admin: parent-exclusive numbers (owned by the parent account, not by any rep
//    sub-account), sent with NO act-as → replies land in the admin/owner inbox.
const DEFAULT_REGISTRY: Record<string, RepEntry> = {
  jordan: { actAs: "jordan@sunbizfunding.com", numbers: ["+13106271134"] },
  alex: { actAs: "alex@sunbizfunding.com", numbers: ["+17857910696", "+13523490263"] },
  joe: { actAs: "joe@sunbizfunding.com", numbers: ["+14707908565"] },
  admin: {
    actAs: null,
    numbers: ["+18604071050", "+15624197079", "+15625505490", "+15614650503", "+14707429516"],
  },
};

function sanitizeEntry(key: string, raw: unknown): RepEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { actAs?: unknown; numbers?: unknown };
  const actAs = r.actAs == null ? null : String(r.actAs).trim();
  if (actAs !== null && !EMAIL_RE.test(actAs)) {
    console.warn(`[drip-rep-sms] "${key}" override rejected — bad act-as email`);
    return null;
  }
  const numbers = Array.isArray(r.numbers)
    ? r.numbers.map((n) => String(n || "").trim()).filter((n) => E164_RE.test(n))
    : [];
  if (numbers.length === 0) {
    console.warn(`[drip-rep-sms] "${key}" override rejected — no valid E.164 numbers`);
    return null;
  }
  return { actAs, numbers };
}

let _cached: Record<string, RepEntry> | null = null;

// Reserved object keys that must never be settable from external JSON — a
// "__proto__" entry in the env override would otherwise reassign the map's
// prototype instead of adding a rep (prototype pollution). Same input-hygiene
// spirit as the charset allowlists above.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Built-in verified defaults, with any VALID per-rep overrides from
 *  DRIP_REP_SMS_IDENTITIES layered on top. Cached for the lifetime of the
 *  server process (env is fixed per deployment). */
function registry(): Record<string, RepEntry> {
  if (_cached) return _cached;
  const reg: Record<string, RepEntry> = { ...DEFAULT_REGISTRY };
  const rawEnv = (process.env.DRIP_REP_SMS_IDENTITIES || "").trim();
  if (rawEnv) {
    try {
      const parsed = JSON.parse(rawEnv) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        const key = k.toLowerCase();
        if (FORBIDDEN_KEYS.has(key)) {
          console.warn(`[drip-rep-sms] override key "${k}" refused (reserved)`);
          continue;
        }
        const clean = sanitizeEntry(key, v);
        if (clean) reg[key] = clean; // an override wins only if fully valid
      }
    } catch (err) {
      console.warn("[drip-rep-sms] DRIP_REP_SMS_IDENTITIES parse failed — using verified defaults", err);
    }
  }
  _cached = reg;
  return reg;
}


/**
 * The line we ALREADY texted this lead from, if it is still usable.
 *
 * WHY A LOOKUP AND NOT A HASH. pickNumber hashes the lead against the CURRENT
 * pool, so it is only stable while the pool is. Numbers are bought and burned
 * roughly weekly (Adon, 2026-08-13), and every change re-shuffles the modulo —
 * so a lead mid-conversation silently moves to a different number. TextTorrent
 * binds a chat to (contact, from_number), so that does not continue the thread,
 * it starts a SECOND one: the merchant sees a stranger replying to a
 * conversation they were already having, and our own reply matching breaks.
 *
 * Adon's rule is the one hard constraint on rotation: rotate all you like, but
 * keep a conversation on its own line. This is that rule.
 *
 * Returns null for a lead we have never texted, or whose old line is no longer
 * in the rep's active pool (burned/released — the thread cannot continue there
 * anyway, so a fresh pick is correct).
 */
async function stickyLineFor(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  leadId: string,
  allowed: string[],
): Promise<string | null> {
  if (allowed.length === 0) return null;
  try {
    const r = await db
      .from("drip_runs")
      .select("from_identity, sent_at")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .eq("channel", "sms")
      .not("from_identity", "is", null)
      .order("sent_at", { ascending: false })
      .limit(10);
    if (r.error) return null;
    for (const row of (r.data || []) as Array<{ from_identity: string | null }>) {
      // Stored as "rep:+1XXXXXXXXXX"; a dry run is prefixed "dry:" and must not
      // pin a real conversation to a line nothing was ever sent from.
      const id = String(row.from_identity ?? "");
      if (!id || id.startsWith("dry:")) continue;
      const num = id.slice(id.indexOf(":") + 1).trim();
      if (num && allowed.includes(num)) return num;
    }
  } catch {
    // A failed lookup means we cannot prove continuity. Falling through to a
    // fresh pick risks forking one thread; that is worse than a slightly
    // uneven spread, but it is recoverable and silence is not — so we take it
    // and let the caller's normal pick happen.
  }
  return null;
}

/**
 * Resolve the {actAsEmail, senderId, repKey} a drip SMS to this lead sends on.
 * Returns { error } only in the (defensive) case where a rep has no numbers AND
 * the tenant has no Default Business Number either — the caller retries.
 */
export async function resolveDripSmsIdentity(
  tenantId: string,
  leadId: string,
  data: Record<string, unknown>,
): Promise<DripSmsIdentity | { error: string }> {
  const reg = registry();
  const repKey = classifyRep(data);

  // LIVE NUMBERS FIRST (2026-08-07). The static registry below is a snapshot,
  // and TextTorrent numbers rotate: the list was "VERIFIED live 2026-07-09" and
  // had rotted by 07-13 — jordan's only configured number gone, joe's
  // sub-account vanished, 3 of admin's 5 dead. Every send from a dead number
  // returned 422, and 1,070 of them were recorded as 'sent'.
  //
  // sms_sender_numbers is refreshed twice daily by /api/cron/sync-sms-numbers,
  // so a rotation is picked up automatically instead of silently failing until
  // someone notices.
  try {
    const db = getServiceSupabase();
    const live = await liveNumbersFor(db, tenantId, repKey);
    if (live.length > 0) {
      // Continuity beats rotation. Rotate freely for NEW conversations; an
      // existing one stays on the line it started on. The rule itself lives in
      // rep-line-core so it is testable without a server runtime.
      const sticky = await stickyLineFor(db, tenantId, leadId, live);
      const chosen = chooseLine({ pool: live, leadId, sticky });
      if (chosen.line) {
        // actAsEmailForRep, not the static registry. The registry is a snapshot
        // and its number lists have already rotted twice; the account a rep
        // sends under is derived from the same place the sync stamps it, so the
        // wire and the line can never disagree.
        return { actAsEmail: actAsEmailForRep(repKey), senderId: chosen.line, repKey };
      }
    }
  } catch {
    // Sync table unreadable — fall through to this rep's static list below.
    // Being wrong about WHICH of the rep's numbers is recoverable.
  }

  // ── NO CROSS-WIRE FALLBACK ────────────────────────────────────────────────
  //
  // This used to fall through to ADMIN's pool, as admin, whenever a rep had no
  // live number of their own — and, further down, to the tenant Default
  // Business Number, also as admin. Three separate paths quietly collapsed
  // every rep onto one line.
  //
  // Adon, 2026-08-13: "There are three separate wires for three separate
  // TextTorrent accounts... we need to have each of them using their own
  // numbers not all of them using one number. That defeats the entire purpose."
  //
  // He is right, and it is not only an attribution problem. Each account is
  // separately registered with the carrier, so sending Alex's merchant from
  // Matt's line under Matt's account breaks the sender identity the merchant
  // already knows, splits the reply thread onto an account the rep cannot see,
  // and concentrates every rep's volume onto one number — which is how a number
  // gets burned in the first place. It was also self-concealing: the send
  // "worked", so nothing ever reported that a rep had no line.
  //
  // A rep with no usable number is BLOCKED, not redirected. The caller holds
  // the row and someone buys a number. See [[feedback_blocking_not_error]].
  const entry = reg[repKey];
  if (entry && entry.numbers.length > 0) {
    // Same rule as the live path — one implementation, so the static fallback
    // cannot drift into picking differently from the thing it backs up.
    const chosen = chooseLine({ pool: entry.numbers, leadId, sticky: null });
    if (chosen.line) return { actAsEmail: entry.actAs, senderId: chosen.line, repKey };
  }
  // The admin wire may still use the tenant default — that IS admin's own line,
  // so it crosses nothing.
  if (repKey === "admin") {
    const tenantDefault = await resolveTextTorrentSenderId({ tenantId });
    if (tenantDefault) return { actAsEmail: null, senderId: tenantDefault, repKey: "admin" };
  }
  return { error: `rep_has_no_line:${repKey}` };
}
