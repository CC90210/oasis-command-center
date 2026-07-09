/**
 * lib/operator-name.ts — hardwired per-account operator display-name overrides.
 *
 * Some accounts must be addressed by a specific name in every chat surface,
 * independent of the display_name/full_name on their user_profiles row. This
 * is the single source of truth for those overrides so the assistant chat, the
 * agentic chat, and the visible chat greeting all agree.
 *
 * Matt account (owner, Submissions@sunbizfunding.com, auth_user_id
 * 871a3e7e-a49a-4ac4-b44d-b1ad2eb6b7d6): the chat must refer to the operator
 * ONLY as "Uri". Requested by Adon 2026-07-08. Keyed on BOTH auth_user_id
 * (precise, immune to a display-name edit) and email (a readable backstop);
 * either match wins.
 */

type OverrideRule = {
  /** Preferred, precise key — the user_profiles.auth_user_id. */
  authUserId?: string;
  /** Backstop key — the login email, compared case-insensitively. */
  email?: string;
  /** The name the chat surfaces must use for this operator. */
  name: string;
};

const OPERATOR_NAME_OVERRIDES: OverrideRule[] = [
  {
    authUserId: "871a3e7e-a49a-4ac4-b44d-b1ad2eb6b7d6",
    email: "submissions@sunbizfunding.com",
    name: "Uri",
  },
];

/**
 * Returns the hardwired name for this operator, or null when there's no
 * override (the caller keeps its normal display_name || full_name || email
 * fallback). Safe with partial identity: pass whichever of authUserId / email
 * the call site has.
 */
export function operatorNameOverride(id: {
  authUserId?: string | null;
  email?: string | null;
}): string | null {
  const authUserId = id.authUserId ?? null;
  const email = (id.email ?? "").trim().toLowerCase() || null;
  for (const rule of OPERATOR_NAME_OVERRIDES) {
    if (rule.authUserId && authUserId && rule.authUserId === authUserId) return rule.name;
    if (rule.email && email && rule.email.toLowerCase() === email) return rule.name;
  }
  return null;
}
