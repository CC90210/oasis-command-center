/**
 * notify/telegram.ts — server-side Telegram sender with EXPLICIT lanes.
 *
 * Every send must name who it is for. There is no default.
 *
 * WHY THERE IS NO DEFAULT
 * -----------------------
 * There used to be one, and it caused a cross-tenant notification leak.
 *
 * This app serves two different audiences out of one codebase: CC, who owns
 * OASIS and wants his own funnel leads, and Adon/APEX, who run SunBiz
 * operations and need alerts about scrapers, bounces and dialer compliance.
 * Until 2026-08-02 both audiences shared one credential pair — sendTelegram()
 * fell back to OASIS_TELEGRAM_BOT_TOKEN / OASIS_TELEGRAM_CHAT_ID, and those
 * were the ONLY Telegram variables set in Vercel production. Nine call sites
 * across funnel alerts, cron watchdogs and agent alerts all relied on that
 * single implicit default.
 *
 * So the credential pair had exactly one correct value and two audiences, and
 * whichever audience it pointed at, the other was misrouted:
 *
 *   - pointing at @KnutRPEbot (Adon): SunBiz ops alerts landed correctly, and
 *     CC's own lead notifications went silently into a partner's private chat
 *     for 34 days, every send returning ok:true.
 *   - repointing it at CC (2026-08-02 01:22) fixed the funnel and immediately
 *     redirected TPS backlog, bounce-reader and Kixie compliance alerts into
 *     CC's DM, while Adon — the only person who can action them — went blind.
 *
 * Both states were broken, because the defect was never the value. It was that
 * one implicit default served two audiences, so any change to it silently
 * rerouted traffic belonging to somebody else. A shared default is an invisible
 * coupling between unrelated features.
 *
 * Hence: `lane` is required, and the type is a discriminated union so omitting
 * it is a compile error rather than a silent inheritance. Adding a new caller
 * now forces the author to answer "who is this for?" — which is the question
 * whose absence caused the leak.
 *
 * FAIL CLOSED
 * -----------
 * An unconfigured lane returns {ok:false, reason:"telegram_lane_not_configured:<lane>"}.
 * It must NEVER fall back to another lane's credentials. Delivering an
 * operational alert to the wrong person is worse than not delivering it: silence
 * gets investigated, whereas a misroute looks like success to every layer that
 * can observe it — retries, status checks, durable failure markers — and stays
 * invisible until a human happens to mention they are getting someone else's
 * mail.
 */
import "server-only";

// Pure formatting helper lives in a server-only-free module so message builders
// stay unit-testable. Re-exported here for callers that already import this.
export { escapeTelegramHtml } from "./telegram-format";

/**
 * Who a message is for. Not which bot sends it — that is a deployment detail.
 * Naming the audience rather than the credential is deliberate: a lane survives
 * a bot swap, and it makes the wrong choice read as wrong at the call site.
 */
export type TelegramLane =
  /** CC — OASIS funnel leads, his own business alerts. */
  | "operator"
  /** Adon / APEX — SunBiz operational alerts (scrapers, bounces, dialer). */
  | "sunbiz-ops";

type LaneSpec = {
  tokenKeys: string[];
  chatKeys: string[];
  audience: string;
  /**
   * A SECOND chat in the SAME lane, tried only when the primary send fails.
   *
   * NOT a cross-lane fallback — that is the exact leak this module exists to
   * prevent. This is another address for the SAME audience: for sunbiz-ops the
   * primary is the ops GROUP and the fallback is Adon's own DM, and Adon is the
   * sunbiz-ops audience either way.
   *
   * WHY IT EXISTS. On 2026-08-12 @KnutRPEbot's membership of the ops group read
   * `status: "left"` — it had been removed. Telegram gives a bot no way to
   * re-add itself, so every sunbiz-ops alert was undeliverable until a human
   * acted, and the SMS outage alerted into a void for five days. One delivery
   * address means one removed bot equals total silence.
   */
  fallbackChatKeys?: string[];
};

/**
 * Credential resolution per lane, in order. Fallback chains stay WITHIN a lane —
 * never across lanes, which is the whole point of this module.
 */
const LANES: Record<TelegramLane, LaneSpec> = {
  operator: {
    tokenKeys: ["OASIS_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"],
    chatKeys: ["OASIS_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"],
    audience: "CC (OASIS operator)",
  },
  "sunbiz-ops": {
    // Deliberately does NOT list OASIS_* or bare TELEGRAM_*. If this lane is
    // unset the send fails loudly instead of quietly becoming CC's problem.
    tokenKeys: ["SUNBIZ_OPS_TELEGRAM_BOT_TOKEN", "SUNBIZ_TELEGRAM_BOT_TOKEN"],
    chatKeys: ["SUNBIZ_OPS_TELEGRAM_CHAT_ID"],
    // Adon's own DM. Same audience as the ops group, different address.
    fallbackChatKeys: ["SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID"],
    audience: "SunBiz operations (Adon / APEX)",
  },
};

/**
 * Either name a lane, or supply both credentials explicitly (per-user sends
 * resolved from the database — the linked-account webhook and sunbiz-events).
 * A union rather than optional fields, so "I forgot" cannot compile.
 */
export type TelegramTarget =
  | { lane: TelegramLane }
  | { token: string; chatId: string };

/**
 * Every lane, with the env var NAME that actually resolved for it — never a
 * value. Feeds /api/notify/telegram-identity so the diagnostic enumerates the
 * same lanes the sender uses.
 *
 * Derived from LANES rather than hand-listed on purpose: the first version of
 * that endpoint inspected only the OASIS pair, so it reported a healthy lane
 * while SunBiz alerts were misrouting — a diagnostic blind to the thing that
 * broke. Adding a lane above now adds it to the audit automatically, which is
 * the only version of this that stays true.
 */
export function describeLanes(): Array<{
  lane: TelegramLane;
  audience: string;
  tokenVar: string | null;
  chatVar: string | null;
  configured: boolean;
}> {
  return (Object.keys(LANES) as TelegramLane[]).map((lane) => {
    const spec = LANES[lane];
    const tokenVar = spec.tokenKeys.find((k) => (process.env[k] || "").trim()) ?? null;
    const chatVar = spec.chatKeys.find((k) => (process.env[k] || "").trim()) ?? null;
    return {
      lane,
      audience: spec.audience,
      tokenVar,
      chatVar,
      configured: Boolean(tokenVar && chatVar),
    };
  });
}

/** Credentials for a lane, for diagnostics that must call Telegram directly. */
export function laneCredentials(
  lane: TelegramLane,
): { token: string; chatId: string } | null {
  const r = resolve({ lane });
  return r.ok ? { token: r.token, chatId: r.chatId } : null;
}

function resolve(target: TelegramTarget):
  | { ok: true; token: string; chatId: string; fallbackChatId?: string }
  | { ok: false; reason: string } {
  if ("token" in target) {
    if (!target.token || !target.chatId) {
      return { ok: false, reason: "telegram_explicit_target_incomplete" };
    }
    // An explicit target is the caller naming one address deliberately (a
    // per-user send). It gets no fallback: silently widening the audience of a
    // message addressed to one person is the leak, not the cure.
    return { ok: true, token: target.token, chatId: target.chatId };
  }
  const spec = LANES[target.lane];
  if (!spec) return { ok: false, reason: `telegram_unknown_lane:${target.lane}` };
  const token = spec.tokenKeys.map((k) => process.env[k]).find((v) => v && v.trim());
  const chatId = spec.chatKeys.map((k) => process.env[k]).find((v) => v && v.trim());
  if (!token || !chatId) {
    // Name the lane AND the keys that would fix it. A bare "not configured"
    // sends the next person reading a 502 on a hunt through the env list.
    return {
      ok: false,
      reason:
        `telegram_lane_not_configured:${target.lane} ` +
        `(set ${spec.tokenKeys[0]} + ${spec.chatKeys[0]} for ${spec.audience})`,
    };
  }
  const fallbackChatId = (spec.fallbackChatKeys ?? [])
    .map((k) => process.env[k])
    .find((v) => v && v.trim())
    ?.trim();
  // A fallback pointing at the primary is not a second address. Dropping it
  // keeps "delivered to the fallback" meaning something.
  const usableFallback = fallbackChatId && fallbackChatId !== chatId.trim() ? fallbackChatId : undefined;
  return { ok: true, token: token.trim(), chatId: chatId.trim(), fallbackChatId: usableFallback };
}

export async function sendTelegram(
  text: string,
  target: TelegramTarget,
): Promise<{ ok: boolean; reason?: string; degraded?: boolean }> {
  const r = resolve(target);
  if (!r.ok) return { ok: false, reason: r.reason };

  const primary = await postMessage(r.token, r.chatId, text);
  if (primary.ok) return { ok: true };

  // The primary address refused. Before giving up, try the lane's SECOND
  // address — same audience, different chat. Silence is the failure mode that
  // cost five days on the SMS outage; a message landing in the other of Adon's
  // two chats is not a failure at all.
  if (!r.fallbackChatId) return { ok: false, reason: primary.reason };

  const note =
    `⚠️ Primary alert channel unreachable (${primary.reason}). ` +
    `Delivered here instead — the ops group needs the bot re-added.\n\n`;
  const second = await postMessage(r.token, r.fallbackChatId, note + text);
  if (second.ok) {
    // ok:true because a human WAS reached; degraded:true because the channel
    // they are supposed to use is broken. Collapsing the two into a bare
    // ok:true is how a dead group stays dead — nothing would ever report it.
    return { ok: true, degraded: true, reason: primary.reason };
  }
  return { ok: false, reason: `${primary.reason}; fallback also failed: ${second.reason}` };
}

/**
 * One send attempt to one chat. Split out so the primary and the fallback go
 * through identical error handling rather than two near-copies that drift.
 */
async function postMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4096), // Telegram hard caps messages at 4096 chars
        parse_mode: "HTML",
      }),
      // Callers run inside `after()` on a function with a hard maxDuration.
      // A hung connection is torn down with the function, so the catch below
      // never runs and NOTHING is recorded — the one failure mode a durable
      // error marker cannot cover, because the process does not survive to
      // write it. Bounded so the failure is always reportable.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Telegram puts the actual cause in the body. Returning only the HTTP
      // status made every failure indistinguishable: "chat not found",
      // "bot was blocked by the user" and "can't parse entities" all arrive
      // as 400, and a lead alert that fails without saying why costs a
      // second incident to diagnose. This is what makes the durable marker
      // actionable rather than just present.
      const detail = await res.text().catch(() => "");
      let desc = "";
      try {
        desc = String(JSON.parse(detail)?.description ?? "");
      } catch {
        desc = detail.slice(0, 200);
      }
      return { ok: false, reason: `telegram_http_${res.status}${desc ? `: ${desc}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "telegram_error" };
  }
}
