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

// assigned_to userIds we can pin directly. rep_name is the primary signal; this
// is the fallback for leads whose rep_name hasn't been backfilled yet.
const USERID_TO_REP: Record<string, string> = {
  "871a3e7e-a49a-4ac4-b44d-b1ad2eb6b7d6": "admin", // Matt / submissions@ / owner
};

/** Map a lead's rep_name / assigned_to to a registry rep key. Matches on
 *  whole-word first names (NOT substring) so "Joe Alexson" / "Jordana Smith"
 *  can't misroute to Alex/Jordan and land a reply in the wrong rep's inbox.
 *  Fail-safe: any lead we can't confidently attribute goes on the admin
 *  (owner) account. */
export function classifyRep(data: Record<string, unknown>): string {
  const tokens = String(data.rep_name || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const has = (w: string) => tokens.includes(w);
  if (has("alex")) return "alex";
  if (has("jordan")) return "jordan";
  if (has("joe")) return "joe";
  if (has("matt")) return "admin";
  const asg = String(data.assigned_to || "");
  if (USERID_TO_REP[asg]) return USERID_TO_REP[asg];
  return "admin";
}

/** Deterministic per-lead number pick: a given lead always texts from the same
 *  number (stable inbound threading) while the pool still spreads load across
 *  the rep's leads. */
function pickNumber(numbers: string[], leadId: string): string {
  if (numbers.length === 1) return numbers[0];
  let h = 0;
  for (let i = 0; i < leadId.length; i++) h = (h * 31 + leadId.charCodeAt(i)) >>> 0;
  return numbers[h % numbers.length];
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
  const entry = reg[repKey] || reg.admin;
  if (entry && entry.numbers.length > 0) {
    return { actAsEmail: entry.actAs, senderId: pickNumber(entry.numbers, leadId), repKey };
  }
  // Last-ditch fallback: the tenant Default Business Number as the admin account.
  const tenantDefault = await resolveTextTorrentSenderId({ tenantId });
  if (tenantDefault) return { actAsEmail: null, senderId: tenantDefault, repKey: "admin" };
  return { error: "no_sender_number_resolved" };
}
