/**
 * Shared password floor for every place an operator types a password —
 * /signup, /auth/reset-password, and any future password-change UI in
 * /settings. Keeping this in one module guarantees the rules don't
 * drift (the prior gap: signup required letter+digit, reset only
 * required 8 chars, so a user could RESET to a password they could
 * never have SIGNED UP with).
 *
 * Rules are intentionally minimal — Supabase enforces a 6-char minimum
 * server-side; we add letter+digit so the dictionary-word case
 * ("password", "12345678") fails fast on the client without burning a
 * network round-trip + half-provisioning side-effects.
 */

export function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) {
    return "Password must be at least 8 characters.";
  }
  const hasLetter = /[A-Za-z]/.test(pwd);
  const hasDigit = /\d/.test(pwd);
  if (!hasLetter || !hasDigit) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}

/** Stable copy for use as a `hint` on password input fields. */
export const PASSWORD_HINT =
  "At least 8 characters with a letter and a number.";
