/**
 * The password form's message for a failed /api/auth/turso-login response.
 *
 * Only a 401 means the server checked the credentials and they were wrong.
 * Everything else (rate limit, malformed request, backend missing, an outage)
 * must not read as "Invalid email or password": that hides an outage and
 * sends people to reset a password that was fine (Adon 2026-10-08).
 */
export function loginFailureMessage(status: number): string {
  if (status === 401) return "Invalid email or password.";
  if (status === 429) return "Too many attempts. Wait a few minutes, then try again.";
  if (status === 400) return "Enter your email and password.";
  return "Sign-in is unavailable right now. Try again in a few minutes.";
}
