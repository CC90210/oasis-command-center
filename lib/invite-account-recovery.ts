import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

export type ActiveInviteValidation =
  | { ok: true; tenantId: string; emailPinned: boolean }
  | { ok: false; error: "invalid_or_expired" | "email_mismatch" };

export type InviteConfirmationPreflight =
  | { ok: true }
  | {
      ok: false;
      error: "invalid_or_expired" | "auth_user_not_found" | "email_mismatch";
    };

export type InviteConfirmationPreflightDeps = {
  previewInvite(rawToken: string): Promise<{ emailPinned: string | null } | null>;
  getUserEmail(userId: string): Promise<string | null>;
};

export type InviteEmailConfirmationDeps = InviteConfirmationPreflightDeps & {
  confirmUserEmail(userId: string): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type InviteEmailConfirmationResult =
  | { ok: true }
  | {
      ok: false;
      stage: "preflight";
      error: Exclude<InviteConfirmationPreflight, { ok: true }>["error"];
    }
  | { ok: false; stage: "confirmation"; error: string };

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Bind an unauthenticated invite-finalization request to both capabilities it
 * claims to hold before any email-confirmation mutation occurs:
 *
 *   1. an active invite pinned to one mailbox; and
 *   2. an existing auth user whose canonical mailbox is that same address.
 *
 * The dependency boundary keeps this ordering directly testable with spies, so
 * a future refactor cannot move the privileged confirm call ahead of the
 * preflight without breaking a behavioral test.
 */
export async function preflightInviteEmailConfirmation(
  input: { rawToken: string; userId: string },
  deps: InviteConfirmationPreflightDeps,
): Promise<InviteConfirmationPreflight> {
  const rawToken = input.rawToken.trim();
  if (rawToken.length < 16 || rawToken.length > 512) {
    return { ok: false, error: "invalid_or_expired" };
  }

  const invite = await deps.previewInvite(rawToken);
  const pinnedEmail = invite?.emailPinned
    ? normalizeEmail(invite.emailPinned)
    : "";
  if (!pinnedEmail) return { ok: false, error: "invalid_or_expired" };

  const userEmailRaw = await deps.getUserEmail(input.userId);
  const userEmail = userEmailRaw ? normalizeEmail(userEmailRaw) : "";
  if (!userEmail) return { ok: false, error: "auth_user_not_found" };
  if (userEmail !== pinnedEmail) return { ok: false, error: "email_mismatch" };

  return { ok: true };
}

/** Confirm only after the active invite and auth identity are proven to match. */
export async function confirmInviteBoundEmail(
  input: { rawToken: string; userId: string },
  deps: InviteEmailConfirmationDeps,
): Promise<InviteEmailConfirmationResult> {
  const preflight = await preflightInviteEmailConfirmation(input, deps);
  if (!preflight.ok) {
    return { ok: false, stage: "preflight", error: preflight.error };
  }

  const confirmed = await deps.confirmUserEmail(input.userId);
  return confirmed.ok
    ? { ok: true }
    : { ok: false, stage: "confirmation", error: confirmed.error };
}

/**
 * Verify that a raw invite is still active and may be used by this email.
 *
 * This is deliberately a server-only lookup. Recovery pages may carry the raw
 * invite capability through the browser, but they never get tenant details
 * from this function. A mismatched or stale token is simply omitted from the
 * password-reset continuation, so a reset cannot become a cross-tenant join.
 */
export async function validateActiveInviteForEmail(
  db: Pick<Client, "execute">,
  input: { rawToken: string; email: string; now?: Date },
): Promise<ActiveInviteValidation> {
  const rawToken = input.rawToken.trim();
  if (rawToken.length < 16 || rawToken.length > 512) {
    return { ok: false, error: "invalid_or_expired" };
  }

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const now = (input.now ?? new Date()).toISOString();
  const row = await db.execute({
    sql: `SELECT tenant_id, email
          FROM tenant_invites
          WHERE token_hash = ?
            AND redeemed_at IS NULL
            AND revoked_at IS NULL
            AND unixepoch(expires_at) > unixepoch(?)
          LIMIT 1`,
    args: [tokenHash, now],
  });
  if (!row.rows.length) return { ok: false, error: "invalid_or_expired" };

  const invite = row.rows[0] as { tenant_id?: unknown; email?: unknown };
  const pinnedEmail = typeof invite.email === "string" ? normalizeEmail(invite.email) : "";
  if (!pinnedEmail) return { ok: false, error: "invalid_or_expired" };
  if (pinnedEmail !== normalizeEmail(input.email)) {
    return { ok: false, error: "email_mismatch" };
  }

  const tenantId = typeof invite.tenant_id === "string" ? invite.tenant_id : "";
  return tenantId
    ? { ok: true, tenantId, emailPinned: true }
    : { ok: false, error: "invalid_or_expired" };
}
