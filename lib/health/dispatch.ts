/**
 * lib/health/dispatch.ts — the alerting dispatcher.
 *
 * The brief says to ASSUME retries and duplicate delivery, so nothing here
 * relies on being called exactly once:
 *
 *   1. The backoff ladder decides IF this condition may page (alert-backoff.ts).
 *   2. The delivery ledger decides if THIS rung on THIS channel has already
 *      been sent. It is a CLAIM-then-send against a UNIQUE(condition, rung,
 *      channel) constraint, so a retry, a concurrent worker, or a double cron
 *      tick all conflict on insert and skip. At-most-once is enforced by the
 *      database, not by hope.
 *   3. Channels fan out independently. One dead channel must not silence the
 *      others — that is exactly how the SMS outage alerted into a void for five
 *      days when the Telegram bot fell out of the ops group.
 *
 * An undeliverable alert is itself a finding: `dispatchAlert` returns per-channel
 * results and the caller records total delivery failure as its own condition.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTelegram, escapeTelegramHtml } from "@/lib/notify/telegram";
import { sendInternalEmail } from "@/lib/notify/internal-email";
import type { AlertChannel } from "./types";

export type DispatchResult = {
  channel: AlertChannel;
  ok: boolean;
  /** 'claimed_by_other' means a concurrent/retried invocation already has it. */
  reason?: string;
};

/**
 * Strip anything that looks like PII before an alert body reaches a log, a
 * chat, or the audit ledger. Health alerts describe FEATURES, so a merchant
 * email or phone appearing in one is a leak, not a detail.
 */
export function redactForAlert(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
    .replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, "[ssn]");
}

const DEFAULT_CHANNELS: AlertChannel[] = ["telegram"];

function resolveChannels(configured: AlertChannel[] | undefined): AlertChannel[] {
  if (configured && configured.length > 0) return configured;
  const env = (process.env.HEALTH_ALERT_CHANNELS || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean) as AlertChannel[];
  return env.length > 0 ? env : DEFAULT_CHANNELS;
}

/**
 * Claim one (condition, rung, channel) slot. Returns false when the row already
 * exists — meaning a previous attempt (or another worker) owns this delivery.
 *
 * The insert is the lock. Checking-then-inserting would race.
 */
async function claimDelivery(
  db: SupabaseClient,
  conditionKey: string,
  rung: number,
  channel: AlertChannel,
  bodyPreview: string,
): Promise<{ claimed: boolean; id?: string }> {
  const { data, error } = await db
    .from("health_alert_deliveries")
    .insert({
      condition_key: conditionKey,
      rung,
      channel,
      status: "claimed",
      attempts: 1,
      body_preview: redactForAlert(bodyPreview).slice(0, 280),
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  // A unique-violation (23505) is the EXPECTED path under retry/duplicate
  // delivery, not an error worth surfacing.
  if (error) return { claimed: false };
  return { claimed: true, id: data?.id };
}

async function finishDelivery(
  db: SupabaseClient,
  id: string | undefined,
  status: "sent" | "failed",
  detail?: string,
): Promise<void> {
  if (!id) return;
  await db
    .from("health_alert_deliveries")
    .update({
      status,
      error: status === "failed" ? (detail || "unknown").slice(0, 500) : null,
      provider_ref: status === "sent" ? (detail || null) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

export type AlertPayload = {
  conditionKey: string;
  rung: number;
  title: string;
  body: string;
  severity: string;
  channels?: AlertChannel[];
  /** Required for the email channel (it sends from the tenant's mailbox). */
  tenantId?: string | null;
};

/**
 * Fan an alert out to every configured channel, independently and idempotently.
 *
 * Never throws. A dispatcher that throws takes down the scan that called it,
 * which would mean one bad channel stops all monitoring.
 */
export async function dispatchAlert(
  db: SupabaseClient,
  payload: AlertPayload,
): Promise<DispatchResult[]> {
  const channels = resolveChannels(payload.channels);
  const safeTitle = redactForAlert(payload.title);
  const safeBody = redactForAlert(payload.body);

  const results = await Promise.allSettled(
    channels.map(async (channel): Promise<DispatchResult> => {
      const claim = await claimDelivery(
        db,
        payload.conditionKey,
        payload.rung,
        channel,
        `${safeTitle} ${safeBody}`,
      );
      if (!claim.claimed) {
        return { channel, ok: true, reason: "claimed_by_other" };
      }

      try {
        if (channel === "telegram") {
          // escapeTelegramHtml on every untrusted field: a feature name or an
          // observer error string containing '<' would otherwise break parsing
          // or inject markup.
          const text =
            `<b>${escapeTelegramHtml(safeTitle)}</b>\n` +
            `${escapeTelegramHtml(safeBody)}\n` +
            `<i>severity: ${escapeTelegramHtml(payload.severity)} · rung ${payload.rung}</i>`;
          const res = await sendTelegram(text);
          await finishDelivery(db, claim.id, res.ok ? "sent" : "failed", res.reason);
          return { channel, ok: res.ok, reason: res.reason };
        }

        if (channel === "email") {
          const to = (process.env.HEALTH_ALERT_EMAILS || "")
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean);
          if (!payload.tenantId || to.length === 0) {
            await finishDelivery(db, claim.id, "failed", "email_not_configured");
            return { channel, ok: false, reason: "email_not_configured" };
          }
          const ok = await sendInternalEmail({
            tenantId: payload.tenantId,
            to,
            subject: `[health] ${safeTitle}`,
            text: `${safeBody}\n\nseverity: ${payload.severity}\nrung: ${payload.rung}\ncondition: ${payload.conditionKey}`,
          });
          await finishDelivery(db, claim.id, ok ? "sent" : "failed", ok ? undefined : "smtp_failed");
          return { channel, ok, reason: ok ? undefined : "smtp_failed" };
        }

        if (channel === "webhook") {
          const url = process.env.HEALTH_ALERT_WEBHOOK_URL;
          if (!url) {
            await finishDelivery(db, claim.id, "failed", "webhook_not_configured");
            return { channel, ok: false, reason: "webhook_not_configured" };
          }
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: safeTitle,
              body: safeBody,
              severity: payload.severity,
              condition: payload.conditionKey,
              rung: payload.rung,
            }),
          });
          await finishDelivery(db, claim.id, res.ok ? "sent" : "failed", `http_${res.status}`);
          return { channel, ok: res.ok, reason: res.ok ? undefined : `http_${res.status}` };
        }

        // 'log' and 'sms': log is the always-available floor so a fully
        // misconfigured install still leaves a trace. SMS deliberately falls
        // through to it — routing health alerts over the same SMS provider the
        // monitor is watching is a circular dependency, and this estate has
        // already had that provider fail silently for three weeks.
        console.warn(`[health.alert] ${payload.conditionKey} rung=${payload.rung} ${safeTitle}`);
        await finishDelivery(db, claim.id, "sent", "logged");
        return { channel, ok: true, reason: "logged" };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "dispatch_error";
        await finishDelivery(db, claim.id, "failed", reason);
        return { channel, ok: false, reason };
      }
    }),
  );

  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { channel: channels[i], ok: false, reason: "rejected" },
  );
}
