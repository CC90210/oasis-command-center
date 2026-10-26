/**
 * notify/alert-route.ts - THE place an alert's Telegram audience is chosen.
 *
 * WHY ONE RESOLVER (2026-10-02). The lane used to be a constant at each call
 * site: the drips executor paged "operator" for a carrier outage while the
 * reconcile cron paged "sunbiz-ops" for the same alert type on the same
 * card, the reply agent paged "operator" for every workspace's customers, and
 * a client workspace's alerts could only ever reach an OASIS chat. The lane is
 * a property of the WORKSPACE, never of the call site, so it is decided here,
 * from the tenant id alone:
 *
 *   - OASIS's own workspaces (isOasisInternalTenant, by id) -> OASIS's
 *     "operator" chat;
 *   - the retired SunBiz workspace -> nobody: its card is kept, nothing pages;
 *   - any other workspace -> the bot it saved under Connections > Telegram
 *     (./workspace-telegram.ts), or nobody outside the app when it saved none.
 *
 * Every alert sender goes through pushWorkspaceAlert. A file other than this
 * one and ./telegram.ts that names a lane fails tests/workspace-alerts.test.ts
 * (a ratchet: the few files still allowed are listed there with the reason).
 *
 * THE OUTCOME IS WORDS. What the push did is returned in the words an alert
 * card shows its owner ("Sent to Telegram", "Not sent: no Telegram bot
 * connected"), one wording for every caller.
 *
 * EMAIL WHEN TELEGRAM REFUSES (2026-10-26). OASIS's bot token was revoked and
 * every booking and AI-audit alert since at least 2026-10-19 died as
 * "Telegram said: Unauthorized": CC never heard about the calls people booked,
 * and missed them. So when OASIS's own lane refuses an alert, it goes to CC's
 * own inbox instead (founderAlertEmail): only OASIS's workspaces, only the team
 * address, never a client's audience. The same alert text within the same hour
 * carries one idempotency key, which is one Message-ID, so a retry or a
 * repeating signal is one email, not a stream. The global kill switch
 * BRAVO_FORCE_DRY_RUN=1 stops it; the dashboard's customer send mode does not,
 * as it does not stop the support desk's founder alerts (lib/delivery/notify.ts):
 * this mail is to OASIS's founder, never to a customer.
 */
import "server-only";
import { createHash } from "node:crypto";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { sendOasisSharedGmail } from "@/lib/integrations/oasis-shared-gmail-send";
import { laneCredentials, sendTelegram } from "@/lib/notify/telegram";
import { sendWorkspaceTelegram, workspaceTelegramOutcome } from "@/lib/notify/workspace-telegram";
import { OASIS_PIPELINE_ASSIGNMENT_EMAILS } from "@/lib/team";
import { isRetiredTenant } from "@/lib/tenant/retired";

/** Who a workspace's alerts reach outside the app. */
export type AlertAudience = "oasis_operator" | "workspace_bot" | "card_only";

export function alertAudienceFor(tenantId: string | null | undefined): AlertAudience {
  if (isRetiredTenant(tenantId)) return "card_only";
  if (isOasisInternalTenant(tenantId)) return "oasis_operator";
  return "workspace_bot";
}

export type AlertPush = {
  /** A person was reached. */
  delivered: boolean;
  /** What happened, in the words the card shows. */
  outcome: string;
};

type LaneResult = { ok: boolean; reason?: string; degraded?: boolean };

/**
 * OASIS's own chat's answer, in the card's words. A delivery that only
 * reached a lane's backup chat is not "Sent": the chat its people read is
 * broken, and the card must say so. A refusal can quote the request back, bot
 * token included, so the lane's `token` is cut out before any of Telegram's
 * words reach the card (./workspace-telegram.ts does the same for a
 * workspace's own bot). Exported for tests.
 */
export function oasisLaneOutcome(sent: LaneResult, token?: string | null): string {
  if (sent.ok && !sent.degraded) return "Sent to Telegram";
  if (sent.ok) return "Sent to the backup Telegram chat: the main chat refused it";
  const raw = sent.reason || "";
  const reason = token ? raw.split(token).join("[token]") : raw;
  if (reason.startsWith("telegram_lane_not_configured")) return "Not sent: the Telegram alert chat is not set up";
  const http = /^telegram_http_(\d+)(?::\s*([\s\S]*))?$/.exec(reason);
  if (http) return `Not sent: Telegram said: ${(http[2]?.trim() || `HTTP ${http[1]}`).slice(0, 200)}`;
  return "Not sent: Telegram could not be reached";
}

/**
 * What an alert is about, for OASIS's own workspaces only. A new lead on
 * oasisai.work is CC's sales desk, so it goes to the owner lane. A client workspace has
 * no desks of OASIS's: it always reaches its own bot, whatever it asks for.
 */
export type AlertDesk = "sales";

/** One alert email to OASIS's founder. `ok: false` carries why, in a short line. */
export type FounderAlertEmail = (m: {
  tenantId: string;
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
}) => Promise<{ ok: boolean; error?: string }>;

/** The real one: OASIS's shared mailbox, as an internal alert to the team (past the opt-out list, to the team list only). */
const sendFounderAlertEmail: FounderAlertEmail = async (m) => {
  const r = await sendOasisSharedGmail({
    tenantId: m.tenantId,
    to: m.to,
    subject: m.subject,
    body: m.body,
    idempotencyKey: m.idempotencyKey,
    purpose: "support",
    internalAlert: true,
  });
  return r.ok ? { ok: true } : { ok: false, error: `${r.reason}: ${r.error}` };
};

/**
 * An alert's Telegram HTML as plain text: tags dropped (a link keeps its
 * address), the entities escapeTelegramHtml wrote decoded once. Exported for tests.
 */
export function alertPlainText(html: string): string {
  return html
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const words = label.replace(/<[^>]+>/g, "").trim();
      return words && words !== href ? `${words} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** A short stable fingerprint of an alert's text, for its idempotency key (sha256, as gmailMessageIdForIdempotencyKey hashes). */
function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * The email that stands in for a Telegram alert OASIS's lane refused: to the
 * first address on the team list, subject from the alert's first line. Its key
 * is the lane, the text and the hour, so the same alert is one email an hour.
 * Exported for tests.
 */
export function founderAlertMessage(
  text: string,
  lane: string,
  telegramOutcome: string,
  now: Date,
): { to: string; subject: string; body: string; idempotencyKey: string } {
  const plain = alertPlainText(text);
  const firstLine = plain.split("\n").find((l) => l.trim())?.trim() || "An alert";
  const reason = telegramOutcome.replace(/^Not sent:\s*/, "");
  return {
    to: OASIS_PIPELINE_ASSIGNMENT_EMAILS[0],
    subject: `OASIS alert: ${firstLine}`.slice(0, 140),
    body:
      `${plain}\n\n` +
      `This came by email because Telegram refused it (${reason}). ` +
      "Alerts will keep arriving here until the OASIS Telegram bot token is replaced.",
    idempotencyKey: `alert-email:${lane}:${fingerprint(text)}:${now.toISOString().slice(0, 13)}`,
  };
}

/**
 * Push one alert (Telegram HTML, already escaped) to this workspace's own
 * audience. Never throws, never reaches another workspace's chat. For OASIS's
 * own workspaces a refused Telegram push is emailed to the founder instead
 * (see the header); `email` replaces that sender in tests.
 */
export async function pushWorkspaceAlert(
  tenantId: string,
  text: string,
  opts?: { desk?: AlertDesk; email?: FounderAlertEmail; now?: Date },
): Promise<AlertPush> {
  const audience = alertAudienceFor(tenantId);
  if (audience === "card_only") return { delivered: false, outcome: "Not sent: this workspace is retired" };
  if (audience === "oasis_operator") {
    const lane = opts?.desk === "sales" ? "sales" : "operator";
    const sent: LaneResult = await sendTelegram(text, { lane }).catch((err: unknown) => ({
      ok: false,
      reason: err instanceof Error ? err.message : "telegram_error",
    }));
    const outcome = oasisLaneOutcome(sent, laneCredentials(lane)?.token);
    if (sent.ok) return { delivered: true, outcome };
    if ((process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1") {
      return { delivered: false, outcome: `${outcome}. Not emailed either: sending is switched off (dry run)` };
    }
    const message = founderAlertMessage(text, lane, outcome, opts?.now ?? new Date());
    const mailed = await (opts?.email ?? sendFounderAlertEmail)({ tenantId, ...message }).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : "email_error",
    }));
    if (mailed.ok) return { delivered: true, outcome: `${outcome}. Emailed to ${message.to} instead` };
    console.error("[alert-route] Telegram refused an OASIS alert and the email fallback failed too", {
      tenantId,
      lane,
      telegram: outcome,
      email: (mailed.error || "unknown").slice(0, 200),
    });
    return { delivered: false, outcome: `${outcome}. The email fallback failed too (${(mailed.error || "unknown").slice(0, 120)})` };
  }
  const result = await sendWorkspaceTelegram(tenantId, text);
  return { delivered: result.ok, outcome: workspaceTelegramOutcome(result) };
}
