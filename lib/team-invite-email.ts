type InviteEmailEnvironment = Record<string, string | undefined>;

const OASIS_DASHBOARD_ORIGIN = "https://oasisai.work";

function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Canonical dashboard origin for links placed in email.
 *
 * Request/Host headers are intentionally not accepted here: an invite email is
 * an external trust boundary, so a forged Host header must never decide where
 * a teammate is sent. Production normally supplies PUBLIC_APP_URL; the proven
 * OASIS apex is the fail-closed fallback.
 */
export function teamInviteOrigin(
  env: InviteEmailEnvironment = process.env,
): string {
  return (
    safeOrigin(env.PUBLIC_APP_URL) ||
    safeOrigin(env.OASIS_PUBLIC_ORIGIN) ||
    safeOrigin(env.NEXT_PUBLIC_SITE_URL) ||
    safeOrigin(env.NEXT_PUBLIC_APP_URL) ||
    OASIS_DASHBOARD_ORIGIN
  );
}

export function teamInviteUrl(
  rawToken: string,
  env: InviteEmailEnvironment = process.env,
): string {
  return `${teamInviteOrigin(env)}/invite/${encodeURIComponent(rawToken)}`;
}

export function teamInviteEmailText(input: {
  roleLabel: string;
  inviteUrl: string;
  expiresAt: string;
}): string {
  const expires = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(input.expiresAt));

  return [
    "You have been invited to the OASIS AI Command Center.",
    "",
    `Role: ${input.roleLabel}`,
    "",
    "Create your account or sign in using this one-time link:",
    input.inviteUrl,
    "",
    `This link expires ${expires}.`,
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");
}
