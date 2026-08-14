/**
 * lib/drips/rep-keys.ts — the two mappings that decide which number a text goes
 * out from, deliberately kept in ONE file.
 *
 * There are two directions and they must agree:
 *
 *   repKeyForOwner()  TextTorrent "purchased by" name  → rep key   (the SYNC)
 *   classifyRep()     a lead's rep_name / assigned_to  → rep key   (the SEND)
 *
 * The sync stores a number under the first; the send path looks it up under the
 * second. If they disagree, the pool for that rep reads empty and every send for
 * them fails — which is a quieter version of the exact outage that motivated
 * this file (1,070 sends from dead numbers, all recorded as 'sent').
 *
 * Matt is the case that matters most: he is the owner/parent account and routes
 * to "admin", which is ALSO the fallback for every lead we cannot confidently
 * attribute. A drift there empties the widest pool in the system.
 *
 * Pure and free of "server-only" so the agreement is directly testable.
 */

/** Map a TextTorrent "purchased by" display name onto our rep key. */
/**
 * The X-ACT-AS-USER a rep key sends under. null = the parent/admin account,
 * which authenticates as itself.
 *
 * Kept here beside repKeyForOwner so the two cannot disagree about who a rep
 * is. Each TextTorrent account is separately registered with the carrier, so
 * sending a rep's line under the wrong account is not cosmetic: it breaks the
 * sender identity the merchant already knows and lands the reply in an inbox
 * that rep cannot see.
 */
export function actAsEmailForRep(repKey: string): string | null {
  switch (repKey) {
    // The AI Follow-Up wire is a sub-account of the LEGACY parent, not of the
    // main SunBiz SID. The account it authenticates against travels with it in
    // DripSmsIdentity.service; this is only the act-as half of that pair.
    case "ai_followup":
      return "submissions@sunbizfunding.com";
    case "jordan":
      return "jordan@sunbizfunding.com";
    case "alex":
      return "alex@sunbizfunding.com";
    case "joe":
      return "joe@sunbizfunding.com";
    default:
      return null; // admin / parent authenticates as itself
  }
}

export function repKeyForOwner(owner: string | null | undefined): string {
  const o = String(owner || "").toLowerCase();
  // TextTorrent reports these two DIDs as purchased_by "AI Follow-Up"
  // (user_id 1522, verified 2026-08-14). Checked before the rep names: without
  // it they fall through to "admin" below and land in the admin pool, which
  // would text Matt's leads from the Legacy account under an act-as the main
  // SID does not recognise — a 401 on every send.
  if (o.includes("ai follow") || o.includes("ai-follow") || o.includes("aifollow")) return "ai_followup";
  if (o.includes("jordan")) return "jordan";
  if (o.includes("alex")) return "alex";
  if (o.includes("joe")) return "joe";
  // Matt owns the parent account; his leads route to "admin" below.
  if (o.includes("matt")) return "admin";
  return "admin";
}

// assigned_to userIds we can pin directly. rep_name is the primary signal; this
// is the fallback for leads whose rep_name hasn't been backfilled yet.
const USERID_TO_REP: Record<string, string> = {
  "871a3e7e-a49a-4ac4-b44d-b1ad2eb6b7d6": "admin", // Matt / submissions@ / owner
};

/**
 * Map a lead's rep_name / assigned_to to a rep key.
 *
 * Matches on whole-word first names (NOT substring) so "Joe Alexson" or
 * "Jordana Smith" cannot misroute to Alex/Jordan and land a reply in the wrong
 * rep's inbox. Fail-safe: anything we cannot confidently attribute goes to the
 * admin (owner) account.
 */
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
