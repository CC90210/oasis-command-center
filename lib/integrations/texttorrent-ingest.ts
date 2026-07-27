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
import { createHash } from "node:crypto";
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

export function textTorrentMessageFingerprint(m: TtInboxMessage): string {
  const material = [m.to || "", m.from || "", (m.created_at || "").trim(),
    (m.message || "").trim()].join("\n");
  return `tt-fp:${createHash("sha256").update(material).digest("hex")}`;
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
        provider: "texttorrent",
        provider_message_id: textTorrentMessageFingerprint(m),
        from_phone: m.from,
        to_phone: m.to,
        content: m.message,
        content_preview: (m.message || "").slice(0, 1024),
        sent_at: m.created_at || null,
        metadata: { tt_chat_id: m.chat_id || null, tt_synced: true, ...(m.sendStatus ? { tt_send_status: m.sendStatus } : {}) },
      });
    }
    if (toInsert.length) {
      const saved = await db.from("lead_interactions").insert(toInsert)
        .select("id,provider_message_id,to_phone,from_phone,direction,content,lead_id,metadata");
      const { error } = saved;
      if (error) {
        console.error("[tt-ingest] insert failed", error.message);
        skipped += toInsert.length;
      } else {
        inserted += toInsert.length;
        const accounts = await db.from("sunbiz_agent_accounts").select("id,from_number,voice_profile_id")
          .eq("tenant_id", tenantId).eq("provider", "texttorrent").eq("enabled", true);
        if (!accounts.error) {
          const accountRows = (accounts.data || []) as Array<{ id: string; from_number: string; voice_profile_id: string | null }>;
          const profileIds = accountRows.flatMap((a) => a.voice_profile_id ? [a.voice_profile_id] : []);
          const profiles = profileIds.length ? await db.from("agent_voice_profiles")
            .select("id,style_descriptors,compiled_prompt,example_snippets,confidence,model_used,refreshed_at")
            .eq("tenant_id", tenantId).eq("approved", true).in("id", profileIds) : { data: [], error: null };
          if (profiles.error) {
            console.error("[tt-ingest] approved voice profile lookup failed", profiles.error.message);
            skipped += toInsert.length;
            continue;
          }
          const profileById = new Map(((profiles.data || []) as Array<Record<string, unknown> & { id: string }>)
            .map((p) => [p.id, p]));
          const unmapped: Array<{ provider_message_id: string; to_phone: string }> = [];
          const work = ((saved.data || []) as Array<{
            id: string; provider_message_id: string; to_phone: string; from_phone: string;
            direction: string; content: string; lead_id: string | null;
            metadata: { tt_chat_id?: string | null } | null;
          }>).filter((row) => row.direction === "inbound").flatMap((row) => {
            const did = last10(row.to_phone);
            const account = accountRows
              .find((a) => last10(a.from_number) === did);
            if (!account) {
              unmapped.push({ provider_message_id: row.provider_message_id, to_phone: row.to_phone });
              return [];
            }
            if (account?.voice_profile_id && !profileById.has(account.voice_profile_id)) return [];
            return account ? [{
              tenant_id: tenantId, account_id: account.id,
              provider_message_id: row.provider_message_id,
              provider_conversation_id: row.metadata?.tt_chat_id || null,
              source_interaction_id: row.id, inbound_message: row.content,
              conversation: {
                thread_key: row.lead_id ? `lead:${row.lead_id}` : `phone:+${row.from_phone.replace(/\D/g, "")}`,
                to_phone: row.from_phone, lead_id: row.lead_id,
              },
              merchant_context: row.lead_id ? { lead_id: row.lead_id } : {},
              voice_profile: account.voice_profile_id ? profileById.get(account.voice_profile_id) : {},
              status: "pending",
            }] : [];
          });
          if (work.length) {
            const queued = await db.from("texttorrent_inbound_work").upsert(work, {
              onConflict: "tenant_id,provider_message_id", ignoreDuplicates: true,
            });
            if (queued.error) {
              console.error("[tt-ingest] work enqueue failed", queued.error.message);
              skipped += work.length;
            }
          }
          if (unmapped.length) {
            await db.from("agent_events").insert(unmapped.map((row) => ({
              event_type: "TEXTTORRENT_UNMAPPED_DID", publisher_agent: "texttorrent",
              severity: "warn", correlation_id: tenantId,
              payload: {
                tenant_id: tenantId, destination_last4: last10(row.to_phone).slice(-4),
                provider_message_id: row.provider_message_id,
              },
            })));
          }
        }
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
  opts: { maxChats?: number; pages?: number } = {},
): Promise<{ chats: number; scanned: number; inserted: number; skipped: number }> {
  const db = getServiceSupabase();
  // PARENT account (actAsEmail:null) — the full account inbox across all reps.
  // The default (act-as the tenant's sub-account, e.g. jordan@) only sees that
  // sub-account's chats and returns empty threads here, so sync as the parent.
  const creds = await getTextTorrentCredentials(tenantId, { actAsEmail: null });
  const maxChats = Math.max(1, Math.min(opts.maxChats ?? 40, 200));
  const pages = Math.max(1, Math.min(opts.pages ?? 1, 10));

  // Gather candidate chats across `pages` pages of the inbox (each page = 50).
  // page 1 alone is the recent inbox (ongoing sync); more pages reach further
  // back for a history backfill. Stop early on a short/empty page (the last one)
  // or when getInbox fails soft to [] (rate limit); the 429 break in the thread
  // loop below is the real guard on the shared 60/min parent budget.
  const items: TtInboxMessage[] = [];
  for (let p = 1; p <= pages; p++) {
    const page = await getInbox(creds, { limit: 50, page: p }).catch(() => ({ data: [] as TtInboxMessage[] }));
    const pageItems = page.data || [];
    items.push(...pageItems);
    if (pageItems.length < 50) break;
  }
  // Skip chats with UNREAD messages. The live JARVIS Jordan agent detects new
  // merchant replies via unread_count, and getThread() marks a thread read on
  // view — so ingesting an unread chat here would steal that signal and make
  // Jordan miss the reply. Only pull already-read threads (Jordan handles them
  // fast); a reply we skip now is ingested on the next run once it's read.
  const chatIds = Array.from(
    new Set(items.map((m) => m.chat_id).filter(Boolean)),
  ).slice(0, maxChats);

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
