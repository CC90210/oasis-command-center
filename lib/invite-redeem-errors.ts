/**
 * lib/invite-redeem-errors.ts - what a person is told when joining a workspace
 * fails, keyed by the machine code the redemption returned.
 *
 * PURE and dependency-free: the redeem routes (server) and the signup page
 * (client) share one table, so the screen never shows a raw code such as
 * "profile_finalize_failed" again (the 2026-09-29 audit found exactly that on
 * the signup form, after an invite had already been used up).
 *
 * `retryable` means the invite is still valid and trying again can work.
 */

export type InviteRedeemFailure = {
  code: string;
  status: number;
  message: string;
  retryable: boolean;
};

const FAILURES: Record<string, Omit<InviteRedeemFailure, "code">> = {
  profile_finalize_failed: {
    status: 503,
    retryable: true,
    message:
      "Your account is ready, but we could not add you to the workspace just now. Your invite is still valid. Try again in a minute.",
  },
  invite_tenant_changed: {
    status: 409,
    retryable: true,
    message: "This invite changed while you were joining. Try again.",
  },
  invalid_or_expired: {
    status: 410,
    retryable: false,
    message: "This invite is no longer active. Ask the person who invited you for a new link.",
  },
  email_mismatch: {
    status: 403,
    retryable: false,
    message: "This invite was sent to a different email address. Sign in with the address the invite was sent to.",
  },
  email_pin_required: {
    status: 403,
    retryable: false,
    message: "This invite is not tied to an email address, so it cannot be used. Ask for a new link.",
  },
  already_member_of_another_tenant: {
    status: 409,
    retryable: false,
    message:
      "This account already belongs to another workspace. Sign out and use the email this invite was sent to, or ask an admin for help.",
  },
  workspace_already_has_owner: {
    status: 409,
    retryable: false,
    message: "This workspace already has an owner. Ask them to invite you as a teammate.",
  },
  member_deactivated: {
    status: 403,
    retryable: false,
    message: "Your access to this workspace is switched off, so this invite cannot make you its owner. Ask OASIS to turn your access back on first.",
  },
  auth_user_not_found: {
    status: 401,
    retryable: false,
    message: "We could not confirm your account. Sign out, sign back in, and open the invite link again.",
  },
};

const FALLBACK: Omit<InviteRedeemFailure, "code"> = {
  status: 400,
  retryable: true,
  message: "We could not add you to the workspace. Your invite may still be valid. Try again, or ask for a new link.",
};

export function inviteRedeemFailure(code: string | null | undefined): InviteRedeemFailure {
  const key = (code || "").trim();
  const known = Object.prototype.hasOwnProperty.call(FAILURES, key) ? FAILURES[key] : null;
  return { code: known ? key : "redeem_failed", ...(known ?? FALLBACK) };
}

/**
 * The sentence for a failed redemption response, never the raw code. Uses the
 * server's `message` when it sent one; otherwise looks the code up.
 */
export function inviteRedeemMessage(body: { error?: string | null; message?: string | null } | null | undefined): string {
  const message = (body?.message || "").trim();
  if (message && !/^[a-z0-9_]+$/.test(message)) return message;
  return inviteRedeemFailure(body?.error || message).message;
}
