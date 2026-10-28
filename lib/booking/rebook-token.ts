/**
 * lib/booking/rebook-token.ts - the signed link a lead uses to pick a new time
 * for a founder meeting that did not happen (CC, 2026-10-28).
 *
 * WHY A LINK OF ITS OWN. oasisai.work/book refuses a lead who already has a
 * meeting (`already_booked`, `lead_stage_not_bookable`), so every "pick a new
 * time" email that pointed there sent a missed lead to a page that turned them
 * away. This link names ONE appointment and moves that appointment
 * (rescheduleVerifiedFounderMeeting), so the lead, their audit and their
 * history stay one record.
 *
 * THE TOKEN: base64url(JSON claims) "." base64url(HMAC-SHA256). Keyed with
 * FORM_LINK_HMAC_KEY, the Worker's signer for personalized form links
 * (lib/form-links.ts), under its own domain label so a rebook token can never
 * pass for a form link or the reverse. No key, no link: there is no unsigned
 * development mode, because the link moves a real calendar event.
 *
 * `r` is the appointment's revision when the link was minted. A reschedule
 * bumps it, so a link that already moved its meeting cannot move it again;
 * the page shows the booked time instead.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const REBOOK_KEY_ENV = "FORM_LINK_HMAC_KEY";
/** Two weeks: long enough for a lead who reads email late, short enough that a stale link dies. */
export const REBOOK_TOKEN_TTL_S = 14 * 24 * 60 * 60;
const MIN_KEY_LENGTH = 32;
const MAX_TOKEN_LENGTH = 1024;
const DOMAIN = "oasis-rebook.v1.";

export type RebookClaims = {
  tenantId: string;
  appointmentId: string;
  leadId: string;
  revision: number;
  exp: number;
};

export class RebookNotConfiguredError extends Error {
  constructor() {
    super(`${REBOOK_KEY_ENV} is missing or shorter than ${MIN_KEY_LENGTH} characters`);
    this.name = "RebookNotConfiguredError";
  }
}

function key(env: Readonly<Record<string, string | undefined>>): string {
  const value = (env[REBOOK_KEY_ENV] || "").trim();
  if (value.length < MIN_KEY_LENGTH) throw new RebookNotConfiguredError();
  return value;
}

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${DOMAIN}${payload}`).digest("base64url");
}

export function signRebookToken(
  claims: Omit<RebookClaims, "exp">,
  options: { nowMs?: number; env?: Readonly<Record<string, string | undefined>> } = {},
): string {
  const secret = key(options.env ?? process.env);
  const nowMs = options.nowMs ?? Date.now();
  const body = {
    v: 1,
    t: claims.tenantId,
    a: claims.appointmentId,
    l: claims.leadId,
    r: claims.revision,
    exp: Math.floor(nowMs / 1000) + REBOOK_TOKEN_TTL_S,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

/** The claims of a token this server signed and that has not expired; null for anything else. */
export function verifyRebookToken(
  token: string | null | undefined,
  options: { nowMs?: number; env?: Readonly<Record<string, string | undefined>> } = {},
): RebookClaims | null {
  // The key is checked first, so a missing one is an outage the caller reports, never a quiet "bad link".
  const secret = key(options.env ?? process.env);
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { v, t, a, l, r, exp } = body ?? {};
  if (v !== 1 || typeof t !== "string" || typeof a !== "string" || typeof l !== "string") return null;
  if (!t || !a || !l) return null;
  if (typeof r !== "number" || !Number.isInteger(r) || r < 1) return null;
  if (typeof exp !== "number" || exp * 1000 <= (options.nowMs ?? Date.now())) return null;
  return { tenantId: t, appointmentId: a, leadId: l, revision: r, exp };
}

/** The public page for a token: oasisai.work/book/rebook/<token>. */
export function rebookUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/book/rebook/${token}`;
}
