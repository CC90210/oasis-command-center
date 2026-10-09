/**
 * components/os/department/turn-event.ts - a department channel tells its own
 * header how the turn it just finished went.
 *
 * WHY (CC, 2026-10-09). The header pill is drawn by the server when the page
 * loads, from the channel's last recorded turn. A turn in the channel never
 * redrew it: Chief of Staff answered (or failed) under a pill still saying
 * "Not working: the AI model was not found" from days before. The route
 * records every turn (app/api/agents/chat, lib/os/channel/turns.ts), so a
 * reload was right, but the page in front of the owner was not.
 *
 * AgentChat announces each finished department turn here; LiveStatusPill
 * listens for its own department and redraws the header from that turn with
 * the same rule the server uses (StatusPill.tsx headerAfterTurn). A browser
 * event, not a shared store: the two sit in different parts of the page, and
 * neither owns the other.
 *
 * PURE apart from `window`, which is checked.
 */

export const CHANNEL_TURN_EVENT = "oasis:channel-turn";

/** A finished turn: it answered, or it failed with this code (lib/os/channel/outcome.ts). */
export type ChannelTurn = { department: string; ok: true } | { department: string; ok: false; code: string };

export function announceTurn(turn: ChannelTurn): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ChannelTurn>(CHANNEL_TURN_EVENT, { detail: turn }));
}

/** The turn an event carries, when it is well formed. */
export function turnFromEvent(ev: Event): ChannelTurn | null {
  const d = (ev as CustomEvent<unknown>).detail as Record<string, unknown> | null | undefined;
  if (!d || typeof d.department !== "string" || !d.department) return null;
  if (d.ok === true) return { department: d.department, ok: true };
  if (d.ok === false && typeof d.code === "string" && d.code) return { department: d.department, ok: false, code: d.code };
  return null;
}
