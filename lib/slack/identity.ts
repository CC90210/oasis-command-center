/**
 * lib/slack/identity.ts - who a Slack user is, as far as OASIS is concerned.
 *
 *   guest      Slack's own flags: is_restricted (multi-channel guest) or
 *              is_ultra_restricted (single-channel guest). Dropped: a guest
 *              never gets an answer or a mirrored message.
 *   external   a user from ANOTHER Slack organisation (Slack Connect): their
 *              team is not the connected team, or Slack marks them a stranger.
 *              Dropped the same way.
 *   teammate   when the Slack user's email (users:read.email) matches an
 *              active teammate of THIS workspace, that profile. Only a linked
 *              owner or admin may approve from Slack (lib/slack/interactivity.ts).
 *
 * Looked up with users.info and cached in external_identities for a day, so a
 * busy channel does not call Slack for every message. A lookup that fails is
 * "unknown", never "not a guest": the caller refuses to act on it.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { usersInfo, type SlackFetch } from "@/lib/slack/client";

/** How long a users.info answer is trusted. */
export const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
/** users.info runs inside Slack's 3-second ACK budget. */
export const IDENTITY_LOOKUP_TIMEOUT_MS = 1_500;

export type SlackIdentity = {
  slackUserId: string;
  displayName: string | null;
  profileId: string | null;
  isGuest: boolean;
  isExternal: boolean;
  isBot: boolean;
};

export type IdentityResult =
  | { ok: true; identity: SlackIdentity; cached: boolean }
  | { ok: false; error: "lookup_failed" | "rate_limited" | "token_rejected"; detail: string };

type Row = Record<string, unknown>;

async function cached(db: Client, tenantId: string, slackUserId: string, nowMs: number): Promise<SlackIdentity | null> {
  const rs = await db.execute({
    sql: `SELECT external_user_id, display_name, profile_id, is_guest, is_external, checked_at
          FROM external_identities WHERE tenant_id = ? AND provider = 'slack' AND external_user_id = ? LIMIT 1`,
    args: [tenantId, slackUserId],
  });
  const r = rs.rows[0] as unknown as Row | undefined;
  if (!r) return null;
  const at = Date.parse(String(r.checked_at));
  if (!Number.isFinite(at) || nowMs - at > IDENTITY_TTL_MS || at > nowMs + 60_000) return null;
  return {
    slackUserId,
    displayName: r.display_name ? String(r.display_name) : null,
    profileId: r.profile_id ? String(r.profile_id) : null,
    isGuest: Number(r.is_guest) === 1,
    isExternal: Number(r.is_external) === 1,
    isBot: false,
  };
}

/** The active teammate in THIS workspace with this email, or null. */
async function teammateByEmail(db: Client, tenantId: string, email: string | null): Promise<string | null> {
  const e = (email || "").trim().toLowerCase();
  if (!e) return null;
  const rs = await db.execute({
    sql: `SELECT id FROM user_profiles WHERE tenant_id = ? AND lower(email) = ? AND deactivated_at IS NULL LIMIT 1`,
    args: [tenantId, e],
  });
  return rs.rows[0] ? String((rs.rows[0] as unknown as Row).id) : null;
}

export async function resolveSlackIdentity(
  db: Client,
  input: { tenantId: string; teamId: string; slackUserId: string; token: string; now: Date; fetchImpl?: SlackFetch },
): Promise<IdentityResult> {
  const hit = await cached(db, input.tenantId, input.slackUserId, input.now.getTime());
  if (hit) return { ok: true, identity: hit, cached: true };

  const info = await usersInfo(input.token, input.slackUserId, { fetchImpl: input.fetchImpl, timeoutMs: IDENTITY_LOOKUP_TIMEOUT_MS });
  if (!info.ok) {
    if (info.error === "rate_limited") return { ok: false, error: "rate_limited", detail: info.error };
    if (["invalid_auth", "account_inactive", "token_revoked", "not_authed"].includes(info.error)) {
      return { ok: false, error: "token_rejected", detail: info.error };
    }
    return { ok: false, error: "lookup_failed", detail: info.error };
  }
  const u = info.data;
  const isGuest = u.is_restricted === true || u.is_ultra_restricted === true;
  const isExternal = u.is_stranger === true || (typeof u.team_id === "string" && u.team_id !== input.teamId);
  const isBot = u.is_bot === true;
  const displayName =
    (u.profile?.display_name || "").trim() || (u.profile?.real_name || "").trim() || (u.real_name || "").trim() || (u.name || "").trim() || null;
  // Only a full member of the connected team may be linked to a teammate.
  const profileId = isGuest || isExternal || isBot || u.deleted ? null : await teammateByEmail(db, input.tenantId, u.profile?.email ?? null);

  const nowIso = input.now.toISOString();
  await db.execute({
    sql: `INSERT INTO external_identities (id, tenant_id, provider, external_team_id, external_user_id, display_name, profile_id,
            is_guest, is_external, checked_at, created_at, updated_at)
          VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, provider, external_user_id) DO UPDATE SET
            external_team_id = excluded.external_team_id,
            display_name = excluded.display_name,
            profile_id = excluded.profile_id,
            is_guest = excluded.is_guest,
            is_external = excluded.is_external,
            checked_at = excluded.checked_at,
            updated_at = excluded.updated_at`,
    args: [
      randomUUID(),
      input.tenantId,
      typeof u.team_id === "string" ? u.team_id : null,
      input.slackUserId,
      displayName ? displayName.slice(0, 120) : null,
      profileId,
      isGuest ? 1 : 0,
      isExternal ? 1 : 0,
      nowIso,
      nowIso,
      nowIso,
    ],
  });
  return { ok: true, identity: { slackUserId: input.slackUserId, displayName, profileId, isGuest, isExternal, isBot }, cached: false };
}
