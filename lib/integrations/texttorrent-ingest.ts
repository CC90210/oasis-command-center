/**
 * lib/integrations/texttorrent-ingest.ts — seed lead_interactions from the
 * Text Torrent inbox (history backfill + ongoing manual sync).
 *
 * The inbound webhook (app/api/webhooks/texttorrent/sms-inbound) only captures
 * NEW inbound texts. This pulls a rep's existing TT threads into the same
 * lead_interactions store so the Conversations "Text Torrent" section shows full
 * history. Idempotent: dedups by counterpart-phone + direction + content, which
 * also matches the webhook's already-stored rows (TT's /inbox returns no stable
 * per-message id, so we can't key off message_id here).
 *
 * Bounded by TT's 60 req/min limit — syncTenantInbox lists the inbox once then
 * pulls up to `maxChats` threads, stopping early on a 429.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  getTextTorrentCredentials,
  getInbox,
  getThread,
  TextTorrentError,
  type TtInboxMessage,
} from "@/lib/integrations/texttorrent";

type Db = ReturnType<typeof getServiceSupabase>;

const last10 = (p: string | null | undefined): string => (p || "").replace(/\D/g, "").slice(-10);

/** Dedup signature within a contact's thread: direction + normalized content. */
function sig(direction: string, content: string | null | undefined): string {
  return `${direction}|${(content || "").trim().toLowerCase().slice(0, 300)}`;
}

/** Best-effort lead match by the inbound `from` phone (mirrors the webhook). */
async function findLeadByPhone(db: Db, tenantId: string, phone: string): Promise<string | null> {
  const l10 = last10(phone);
  if (!l10) return null;
  try {
    const r = await db
      .from("tenant_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .filter("data->>phone", "ilike", `%${l10}%`)
      .limit(1);
    return ((r.data || []) as { id: string }[])[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * Insert any TT messages not already in lead_interactions, grouped by the
 * prospect-side phone. Returns counts. Never throws.
 */
export async function ingestTtInboxMessages(
  db: Db,
  tenantId: string,
  messages: TtInboxMessage[],
): Promise<{ scanned: number; inserted: number; skipped: number }> {
  let inserted = 0,
    skipped = 0;
  // Group by the prospect-side (counterpart) phone.
  const groups = new Map<string, TtInboxMessage[]>();
  for (const m of messages) {
    const counterpart = m.direction === "inbound" ? m.from : m.to;
    const k = last10(counterpart);
    if (!k) {
      skipped++;
      continue;
    }
    const arr = groups.get(k);
    if (arr) arr.push(m);
    else groups.set(k, [m]);
  }

  for (const [k, msgs] of groups) {
    // Existing rows for this phone in this tenant → signature set (dedups
    // against the webhook's inbound rows AND prior syncs).
    const seen = new Set<string>();
    try {
      const existing = await db
        .from("lead_interactions")
        .select("direction, content, content_preview")
        .eq("tenant_id", tenantId)
        .eq("channel", "sms")
        .or(`from_phone.ilike.%${k}%,to_phone.ilike.%${k}%`)
        .limit(500);
      for (const r of (existing.data || []) as Array<{ direction: string | null; content: string | null; content_preview: string | null }>) {
        seen.add(sig(r.direction || "", r.content || r.content_preview || ""));
      }
    } catch {
      // If the lookup fails, fall through — worst case a duplicate, never a crash.
    }

    const leadId = await findLeadByPhone(db, tenantId, k);
    const toInsert: Record<string, unknown>[] = [];
    for (const m of msgs) {
      const dir = m.direction; // already "inbound" | "outbound"
      const s = sig(dir, m.message);
      if (seen.has(s)) {
        skipped++;
        continue;
      }
      seen.add(s);
      toInsert.push({
        tenant_id: tenantId,
        lead_id: leadId,
        type: dir === "inbound" ? "sms_received" : "sms_sent",
        channel: "sms",
        direction: dir,
        agent_source: "texttorrent",
        from_phone: m.from,
        to_phone: m.to,
        content: m.message,
        content_preview: (m.message || "").slice(0, 1024),
        sent_at: m.created_at || null,
        metadata: { tt_chat_id: m.chat_id || null, tt_synced: true },
      });
    }
    if (toInsert.length) {
      const { error } = await db.from("lead_interactions").insert(toInsert);
      if (error) {
        console.error("[tt-ingest] insert failed", error.message);
        skipped += toInsert.length;
      } else {
        inserted += toInsert.length;
      }
    }
  }
  return { scanned: messages.length, inserted, skipped };
}

/**
 * Backfill a tenant's recent TT threads into lead_interactions. Lists the inbox
 * once, then pulls up to `maxChats` full threads (bounded for the 60/min limit;
 * stops early on 429). Idempotent — safe to re-run / schedule.
 */
export async function syncTenantInbox(
  tenantId: string,
  opts: { maxChats?: number } = {},
): Promise<{ chats: number; scanned: number; inserted: number; skipped: number }> {
  const db = getServiceSupabase();
  const creds = await getTextTorrentCredentials(tenantId);
  const maxChats = Math.max(1, Math.min(opts.maxChats ?? 40, 50));

  const inbox = await getInbox(creds, { limit: 50, page: 1 }).catch(() => ({ data: [] as TtInboxMessage[] }));
  const items = inbox.data || [];
  const chatIds = Array.from(new Set(items.map((m) => m.chat_id).filter(Boolean))).slice(0, maxChats);

  let chats = 0,
    scanned = 0,
    inserted = 0,
    skipped = 0;

  if (chatIds.length === 0) {
    // /inbox returned bare messages (no chat granularity) — ingest them directly.
    const r = await ingestTtInboxMessages(db, tenantId, items);
    return { chats: 0, scanned: r.scanned, inserted: r.inserted, skipped: r.skipped };
  }

  for (const chatId of chatIds) {
    let msgs: TtInboxMessage[] = [];
    try {
      const t = await getThread(creds, chatId);
      msgs = t?.data || [];
    } catch (e) {
      if (e instanceof TextTorrentError && e.status === 429) break; // hit the rate limit — stop, next run continues
      continue; // skip a single bad thread
    }
    chats++;
    const r = await ingestTtInboxMessages(db, tenantId, msgs);
    scanned += r.scanned;
    inserted += r.inserted;
    skipped += r.skipped;
  }
  return { chats, scanned, inserted, skipped };
}
