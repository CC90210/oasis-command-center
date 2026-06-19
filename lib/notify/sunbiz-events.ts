import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTelegram } from "@/lib/notify/telegram";
import { buildSunbizEventMessage, type SunbizEventKind } from "@/lib/notify/sunbiz-events-format";

/**
 * Per-agent SunBiz application-event Telegram alerts (Batch 4).
 *
 * On Form 1 / Form 2 / bank-statement events, notify the lead's OWNING agent
 * (lead.data.assigned_to) AND all admins (team_role owner/admin). Chat ids live
 * in user_profiles.custom_fields.telegram_chat_id (set via the self-serve link
 * flow). Fail closed: if the owner has no linked chat (or no owner), admins
 * still receive it; we never guess an agent. Fire-and-forget, never blocks submit.
 * Message builders live in sunbiz-events-format.ts (pure, unit-tested).
 */

export type { SunbizEventKind } from "@/lib/notify/sunbiz-events-format";

type ProfileRow = {
  auth_user_id: string | null;
  team_role: string | null;
  is_owner: boolean | null;
  custom_fields: Record<string, unknown> | null;
};

/** Resolve recipient chat ids: the owning agent (if linked) + every admin (if
 *  linked). Returns the distinct chat-id set. */
export async function resolveSunbizRecipients(
  db: SupabaseClient,
  tenantId: string,
  ownerAuthId: string | null,
): Promise<{ chatIds: string[]; ownerLinked: boolean }> {
  const res = await db
    .from("user_profiles")
    .select("auth_user_id, team_role, is_owner, custom_fields")
    .eq("tenant_id", tenantId);
  const rows = (res.data || []) as ProfileRow[];
  const chatOf = (r: ProfileRow): string | null => {
    const c = r.custom_fields?.telegram_chat_id;
    return typeof c === "string" && c.trim() ? c.trim() : null;
  };
  const owner = (ownerAuthId || "").toLowerCase();
  const chatIds = new Set<string>();
  let ownerLinked = false;
  for (const r of rows) {
    const isAdmin = !!r.is_owner || r.team_role === "admin" || r.team_role === "owner";
    const isOwner = !!owner && !!r.auth_user_id && r.auth_user_id.toLowerCase() === owner;
    if (isAdmin || isOwner) {
      const chat = chatOf(r);
      if (chat) {
        chatIds.add(chat);
        if (isOwner) ownerLinked = true;
      }
    }
  }
  return { chatIds: [...chatIds], ownerLinked };
}

/**
 * Send a SunBiz application-event alert to the lead owner + admins. Reads the
 * lead's owner + contact fields, merges any event `extra`, resolves recipients,
 * sends via the shared bot (SUNBIZ_TELEGRAM_BOT_TOKEN, else the default token).
 * Fully soft-fail.
 */
export async function sendSunbizLeadEvent(input: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  kind: SunbizEventKind;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { db, tenantId, leadId, kind, extra } = input;
    const leadRes = await db
      .from("tenant_records")
      .select("data")
      .eq("id", leadId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const leadData = (leadRes.data as { data?: Record<string, unknown> } | null)?.data || {};
    const ownerAuthId =
      typeof leadData.assigned_to === "string" ? (leadData.assigned_to as string) : null;

    const { chatIds } = await resolveSunbizRecipients(db, tenantId, ownerAuthId);
    if (chatIds.length === 0) return; // nobody linked yet — nothing to send

    const text = buildSunbizEventMessage(kind, { ...leadData, ...(extra || {}) });
    const token = process.env.SUNBIZ_TELEGRAM_BOT_TOKEN || undefined;
    await Promise.allSettled(
      chatIds.map((chatId) =>
        sendTelegram(text, { token, chatId }).then((r) => {
          if (!r.ok) console.error("[sunbiz-events] telegram send:", r.reason);
        }),
      ),
    );
  } catch (err) {
    console.error("[sunbiz-events] threw", err instanceof Error ? err.message : String(err));
  }
}
