/**
 * agent-alert.ts - write an alert card for a workspace, and page whoever owns
 * that workspace's alerts.
 *
 * Two surfaces in one call:
 *  1. A durable `agent_alerts` row: the card. The workspace's owners see it in
 *     Needs you (Today and the Feed, components/os/today) and on the manifest
 *     dashboard, and resolve it with POST /api/agent-alerts/[id]/resolve.
 *  2. For warn/urgent, a Telegram push so a live failure pages someone instead
 *     of waiting to be noticed. WHOSE Telegram is decided by the workspace and
 *     nothing else (lib/notify/alert-route.ts): OASIS's own workspaces page
 *     OASIS's operator chat, any other workspace its own saved bot or nobody
 *     outside the app, the retired SunBiz workspace nobody. Callers do not name
 *     a lane: until 2026-10-02 they did, so a client's alerts (its customers'
 *     texts, escalated by the SMS reply agent) reached CC's phone and the client
 *     heard nothing. What the push did is recorded on the card's payload as
 *     `telegram`, in the words the card shows ("Sent to Telegram", "Not sent:
 *     no Telegram bot connected").
 *
 * The `agent_alerts` schema is owned by the VPS SunBiz-Agent repo (migration
 * 069/health-check convention): columns tenant_id, alert_type, severity
 * ('info'|'warn'|'urgent'), subject_type, subject_id, title, body, payload,
 * created_at, resolved_at, resolved_by. There is no TS insert wrapper
 * elsewhere: this is it.
 *
 * De-duplicated the same way the VPS health-check does: if an UNRESOLVED row for
 * the same (tenant, alert_type, subject) already exists we refresh it instead of
 * inserting a duplicate, so a repeatedly-failing signal (e.g. a bad HMAC secret
 * firing every minute) is ONE open card, not a storm. A card is closed by its
 * owner, or by resolveAgentAlerts when the condition behind it recovers.
 *
 * Best-effort by contract: never throws. A monitoring write must not fail the
 * operation it is monitoring.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { escapeTelegramHtml } from "@/lib/notify/telegram";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";

export type AlertSeverity = "info" | "warn" | "urgent";

/** The outcome an earlier push recorded on an open card, carried across a refresh. */
function recordedPush(payload: unknown): string | null {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const push = (value as Record<string, unknown>).telegram;
  return typeof push === "string" ? push : null;
}

export async function writeAgentAlert(input: {
  tenantId: string;
  alertType: string;
  severity: AlertSeverity;
  title: string;
  body?: string;
  subjectType?: string;
  subjectId?: string;
  payload?: Record<string, unknown>;
  /** Override Telegram push (default: on for warn/urgent, off for info). */
  telegram?: boolean;
  /** Page Telegram only when this call CREATES the open card — a refresh of an
   *  already-open card stays silent. For high-frequency callers (e.g. every
   *  claimed drip row during a TT credit outage) where re-paging per call is a
   *  notification storm (codex review 2026-07-23). Default false = legacy
   *  behavior (page on every call). */
  telegramOncePerOpen?: boolean;
}): Promise<{ stored: boolean; telegram: string | null }> {
  const nowIso = new Date().toISOString();
  // agent_alerts.payload is NOT NULL DEFAULT '{}': an explicit null failed the
  // insert of every alert written without a payload, and the result was never
  // read, so those alerts had no card at all.
  const payload: Record<string, unknown> = input.payload ?? {};
  let refreshedExisting = false;
  let rowId: string | null = null;
  let db: ReturnType<typeof getServiceSupabase> | null = null;
  try {
    db = getServiceSupabase();

    // De-dup against an existing OPEN row for the same signal + subject.
    let q = db
      .from("agent_alerts")
      .select("id, payload")
      .eq("tenant_id", input.tenantId)
      .eq("alert_type", input.alertType)
      .is("resolved_at", null)
      .limit(1);
    q = input.subjectId ? q.eq("subject_id", input.subjectId) : q.is("subject_id", null);
    const existing = await q.maybeSingle();
    if (existing.error) {
      // Fail closed. Not knowing whether a card is open, a write would open a
      // duplicate and page again on every call for as long as reads fail.
      console.error("[agent-alert] open-card lookup failed; alert not written:", existing.error.message);
      return { stored: false, telegram: null };
    }
    const open = existing.data as { id: string; payload?: unknown } | null;
    const existingId = open?.id;
    // A refresh rewrites the payload; keep what the last push did until a new
    // push replaces it.
    const earlierPush = open ? recordedPush(open.payload) : null;

    const row: Record<string, unknown> = {
      tenant_id: input.tenantId,
      alert_type: input.alertType,
      severity: input.severity,
      title: input.title,
      body: input.body ?? null,
      subject_type: input.subjectType ?? null,
      subject_id: input.subjectId ?? null,
      payload: earlierPush ? { ...payload, telegram: earlierPush } : payload,
    };

    if (existingId) {
      // Refresh the open card (bump created_at so it re-sorts to the top).
      // Flag only on a VERIFIED refresh — a failed update errs toward loud
      // (codex review 2026-07-23).
      const upd = await db
        .from("agent_alerts")
        .update({ ...row, created_at: nowIso })
        .eq("tenant_id", input.tenantId)
        .eq("id", existingId);
      if (!upd.error) {
        refreshedExisting = true;
        rowId = existingId;
      } else {
        console.error("[agent-alert] refresh failed:", upd.error.message);
      }
    } else {
      const ins = await db
        .from("agent_alerts")
        .insert({ ...row, created_at: nowIso })
        .select("id")
        .maybeSingle();
      if (ins.error) console.error("[agent-alert] insert failed:", ins.error.message);
      else rowId = (ins.data as { id?: string } | null)?.id ?? null;
    }
  } catch (err) {
    // Write failed → we can't know if a card was open; err toward LOUD
    // (refreshedExisting stays false so Telegram still fires).
    console.error("[agent-alert] write failed:", err instanceof Error ? err.message : err);
  }

  const wantTelegram =
    (input.telegram ?? input.severity !== "info") &&
    !(input.telegramOncePerOpen && refreshedExisting);
  if (!wantTelegram) return { stored: rowId !== null, telegram: null };

  const tag = input.severity === "urgent" ? "🚨" : "⚠️";
  // Telegram HTML mode: a title or body holding "&" or "<" (a sequence or
  // business name) would otherwise be refused as unparseable.
  const text =
    `${tag} ${escapeTelegramHtml(input.title)}` + (input.body ? `\n${escapeTelegramHtml(input.body)}` : "");
  const { outcome: telegram } = await pushWorkspaceAlert(input.tenantId, text);

  if (db && rowId) {
    try {
      const recorded = await db
        .from("agent_alerts")
        .update({ payload: { ...payload, telegram } })
        .eq("tenant_id", input.tenantId)
        .eq("id", rowId);
      if (recorded.error) console.error("[agent-alert] push outcome not recorded:", recorded.error.message);
    } catch (err) {
      console.error("[agent-alert] push outcome not recorded:", err instanceof Error ? err.message : err);
    }
  }
  return { stored: rowId !== null, telegram };
}

/**
 * Close a workspace's open cards of one kind because the condition behind them
 * recovered, so its next occurrence opens a new card and pages again. A card
 * left open would keep a telegramOncePerOpen caller silent through every later
 * recurrence. Returns how many cards it closed; never throws (0 on a failure,
 * which is logged).
 */
export async function resolveAgentAlerts(input: {
  tenantId: string;
  alertType: string;
  /** Why, kept on the card (agent_alerts.resolved_by). */
  resolvedBy: string;
}): Promise<number> {
  try {
    const res = await getServiceSupabase()
      .from("agent_alerts")
      .update({ resolved_at: new Date().toISOString(), resolved_by: input.resolvedBy })
      .eq("tenant_id", input.tenantId)
      .eq("alert_type", input.alertType)
      .is("resolved_at", null)
      .select("id");
    if (res.error) {
      console.error("[agent-alert] recovery close failed:", res.error.message);
      return 0;
    }
    return ((res.data as unknown[] | null) || []).length;
  } catch (err) {
    console.error("[agent-alert] recovery close failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}
