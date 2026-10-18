/**
 * lib/meet/guest-name.ts - the first name a booked meeting's room page fills in for its guest.
 *
 * A meeting a lead booked carries their lead id (meet_rooms.lead_id), and the booking writes their name on their lead
 * record. The room page reads it from that record, in the room's own workspace, by the name fields every form writes
 * (lib/forms/contact-gate.ts), so a lead who booked does not type their name again. Only the first name, through the
 * same greeting rule as the CRM's emails (lib/leads/quick-email-draft.ts firstNameOf): anyone who holds the link sees
 * that page.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { LEAD_COMPANY_KEYS, LEAD_NAME_KEYS } from "@/lib/forms/contact-gate";
import { firstNameOf } from "@/lib/leads/quick-email-draft";
import type { MeetRoom } from "./rooms";

/** What firstNameOf answers when there is no name to greet: a neutral word, never a name to fill in. */
const NO_NAME = "there";

/**
 * The guest's first name, or null: a room no lead booked, no lead record, no name on it, or a name that is really the
 * company's. Never throws: a lookup that fails only leaves the field empty, it never keeps anyone out of the room.
 */
export async function meetGuestFirstName(db: Client, room: Pick<MeetRoom, "tenantId" | "leadId">): Promise<string | null> {
  if (!room.leadId) return null;
  try {
    const rs = await db.execute({
      sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1",
      args: [room.tenantId, room.leadId],
    });
    const raw = rs.rows[0]?.data;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const first = (keys: readonly string[]) =>
      keys.map((key) => data[key]).find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? "";
    const name = firstNameOf(first(LEAD_NAME_KEYS), first(LEAD_COMPANY_KEYS));
    return name === NO_NAME ? null : name;
  } catch (err) {
    console.error("[meet.guest_name] could not read the booked lead's name", err instanceof Error ? err.message : err);
    return null;
  }
}
