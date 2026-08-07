/**
 * lib/drips/sender-sync.ts — keeps the SMS sending numbers in step with reality.
 *
 * THE FAILURE THIS EXISTS FOR. rep-sms-identity.ts carried a hardcoded number
 * list, "VERIFIED live 2026-07-09". TextTorrent numbers get carrier-burned and
 * rotated. By 2026-07-13 the list had rotted — jordan's only configured number
 * was gone, joe's sub-account had vanished, 3 of admin's 5 were dead — and every
 * send from a dead number returned 422. 1,070 failures over three weeks, all
 * recorded as 'sent'.
 *
 * A snapshot of a moving target is not a configuration, it is a countdown. So
 * the numbers are SYNCED from the live API and the send path reads the synced
 * table. The static registry survives only as a last-ditch fallback for the case
 * where the sync itself has never run.
 *
 * Runs on a cron (see /api/cron/sync-sms-numbers). Adon: "we rotate numbers a
 * lot of the time... it needs to automatically update the sending number."
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTextTorrentCredentials } from "@/lib/integrations/texttorrent";
import { repKeyForOwner } from "./rep-keys";

type Db = ReturnType<typeof getServiceSupabase>;

const BASE = "https://api.texttorrent.com/api/v1";

/**
 * Which sub-accounts to enumerate. `null` act-as means the parent/admin account,
 * whose active list includes every number the organisation owns.
 *
 * Deliberately derived from the sub-accounts TextTorrent reports rather than a
 * second hardcoded list — a rep added in TT should appear here without a deploy.
 */
export type RepTarget = { repKey: string; actAsEmail: string | null };

export type SyncResult = {
  scanned: number;
  added: string[];
  deactivated: string[];
  unchanged: number;
  repsWithNoLiveNumbers: string[];
  errors: string[];
};

type ActiveNumber = { number: string; owner: string | null };

async function fetchActive(
  sid: string,
  publicKey: string,
  actAsEmail: string | null,
): Promise<{ numbers: ActiveNumber[] } | { error: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-API-SID": sid,
    "X-API-PUBLIC-KEY": publicKey,
  };
  if (actAsEmail) headers["X-ACT-AS-USER"] = actAsEmail;
  try {
    const r = await fetch(`${BASE}/inbox/numbers/active`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = (await r.json()) as { data?: { data?: Array<Record<string, unknown>> } };
    const rows = j?.data?.data || [];
    return {
      numbers: rows
        .map((n) => ({
          number: String(n.number || "").trim(),
          owner: n.purchased_by_user ? String(n.purchased_by_user) : null,
        }))
        // status 1 is active; anything else must not be sent from.
        .filter((n, i) => n.number && String(rows[i].status) === "1"),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "fetch_failed" };
  }
}


/**
 * Refresh the sender-number table from TextTorrent.
 *
 * FAILS CLOSED on an unreadable API: if the whole enumeration errors, nothing is
 * deactivated. Marking every number dead because TextTorrent had a bad minute
 * would take the entire SMS channel down, which is worse than a stale row.
 */
export async function syncSenderNumbers(tenantId: string): Promise<SyncResult> {
  const db: Db = getServiceSupabase();
  const result: SyncResult = {
    scanned: 0, added: [], deactivated: [], unchanged: 0, repsWithNoLiveNumbers: [], errors: [],
  };

  const creds = await getTextTorrentCredentials(tenantId, { actAsEmail: null });

  // The parent account's active list contains every number the org owns, with
  // the owning rep attached, so ONE call enumerates everything.
  const live = await fetchActive(creds.apiSid, creds.publicKey, null);
  if ("error" in live) {
    result.errors.push(`parent enumeration failed: ${live.error}`);
    return result; // fail closed — deactivate nothing
  }
  result.scanned = live.numbers.length;
  if (live.numbers.length === 0) {
    // An empty list from a 200 response is not proof there are no numbers; it is
    // more likely a permissions or shape change. Do not deactivate on it.
    result.errors.push("active list came back empty — refusing to deactivate anything");
    return result;
  }

  const existing = await db
    .from("sms_sender_numbers")
    .select("id, number, rep_key, active")
    .eq("tenant_id", tenantId);
  if (existing.error) {
    result.errors.push(`could not read stored numbers: ${existing.error.message}`);
    return result;
  }
  const stored = new Map((existing.data || []).map((r) => [r.number, r]));
  const liveSet = new Set(live.numbers.map((n) => n.number));
  const now = new Date().toISOString();

  for (const n of live.numbers) {
    const repKey = repKeyForOwner(n.owner);
    const prev = stored.get(n.number);
    if (!prev) {
      const ins = await db.from("sms_sender_numbers").insert({
        tenant_id: tenantId, rep_key: repKey, act_as_email: null,
        number: n.number, active: true, first_seen_at: now, last_seen_at: now,
      });
      if (ins.error) result.errors.push(`insert ${n.number}: ${ins.error.message}`);
      else result.added.push(`${n.number} (${repKey})`);
    } else {
      await db.from("sms_sender_numbers")
        .update({ last_seen_at: now, active: true, deactivated_at: null, rep_key: repKey })
        .eq("id", prev.id);
      result.unchanged += 1;
    }
  }

  // Anything stored-and-active that is no longer live has rotated away.
  for (const [number, row] of stored) {
    if (liveSet.has(number) || !row.active) continue;
    await db.from("sms_sender_numbers")
      .update({ active: false, deactivated_at: now })
      .eq("id", row.id);
    result.deactivated.push(`${number} (${row.rep_key})`);
  }

  // A rep with no live numbers cannot send at all. That is the condition that
  // produced three weeks of 422s, so it is surfaced explicitly rather than being
  // inferable only from a diff.
  const byRep = new Map<string, number>();
  for (const n of live.numbers) {
    const k = repKeyForOwner(n.owner);
    byRep.set(k, (byRep.get(k) || 0) + 1);
  }
  for (const rep of ["jordan", "alex", "admin"]) {
    if (!byRep.get(rep)) result.repsWithNoLiveNumbers.push(rep);
  }

  return result;
}

/**
 * The numbers a rep may currently send from, newest-verified first.
 * Empty means the rep cannot send — the caller must NOT fall back to a guess.
 */
export async function liveNumbersFor(
  db: Db,
  tenantId: string,
  repKey: string,
): Promise<string[]> {
  try {
    const r = await db
      .from("sms_sender_numbers")
      .select("number")
      .eq("tenant_id", tenantId)
      .eq("rep_key", repKey)
      .eq("active", true)
      .order("last_seen_at", { ascending: false });
    if (r.error) return [];
    return (r.data || []).map((x) => String(x.number));
  } catch {
    return [];
  }
}
