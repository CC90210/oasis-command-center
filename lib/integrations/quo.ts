/**
 * lib/integrations/quo.ts -- texting through Quo (formerly OpenPhone).
 *
 * CC, 2026-10-26: Twilio broke and OASIS's own texting moved to Quo. An owner
 * saves the Quo API key (and, when the Quo workspace has more than one number,
 * the number texts leave from) in Settings > Connections > Quo. Server-only:
 * it reads the workspace's saved key.
 *
 * QUO'S API (read 2026-10-26):
 *   - POST https://api.quo.com/v1/messages sends one text. The raw key goes in
 *     Authorization, with no "Bearer". The body is
 *     {"content": text, "from": number, "to": [number]}, and a 202 answers
 *     {"data": {"id", "status", "conversationId", ...}}.
 *     https://www.quo.com/docs/mdx/api-reference/messages/send-a-text-message
 *   - GET https://api.quo.com/v1/phone-numbers lists the workspace's numbers,
 *     each with where it may text: restrictions.messaging.{CA, US, Intl} is
 *     "unrestricted" or "restricted".
 *     https://quo.com/docs/mdx/api-reference/phone-numbers/list-phone-numbers.md
 *   - A refusal is an HTTP error whose body has a title and a message ("A2P
 *     Registration Not Approved", "International Messaging Not Allowed",
 *     "Daily Conversation Limit Reached"). A 401 may instead be
 *     {"error": {"message", "key": "Unauthorized"}}.
 *   - There is no idempotency key, so a send is never retried here.
 *
 * NEVER A FAKE SUCCESS. Only a 2xx answer that carries the message id Quo gave
 * the text counts as sent. A refusal is a failed send in Quo's own words. No
 * answer, or a 2xx without that id, is a failed send that says the text may
 * still have gone out, because a second try could send it twice.
 *
 * The key never appears in a result, a reason or a log line.
 *
 * The same request as scripts/integrations/send_gateway.py _send_sms_via_quo
 * in CEO-Agent (the sender the agents use), so a text goes out the same way
 * from either side.
 */

import "server-only";

import { getTenantIntegrationBundle, readTenantCredentialStrict } from "@/lib/tenant-integration-store";
import { checkPhoneOptOut } from "@/lib/lead-interactions-queries";
import { isDryRun } from "@/lib/integrations/send-mode";
import { providerSwitchedOn } from "@/lib/routing/provider-availability";
import { isRetiredTenant } from "@/lib/tenant/retired";
import type { Client } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";
import { quoWebhookKeyConfigured } from "@/lib/integrations/quo-webhook";

export const QUO_API_BASE = "https://api.quo.com/v1";

/** Quo's own limit on one text (POST /v1/messages: content is 1 to 1600 characters). */
export const QUO_MAX_TEXT = 1600;

const USER_AGENT = "oasis-command-center-quo/1.0";
const LIST_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 15_000;
const E164 = /^\+[1-9]\d{6,14}$/;

// -- Credentials ----------------------------------------------------------------

export type QuoCredentials = {
  tenantId: string;
  apiKey: string;
  /** The number texts leave from (E.164), or null: the workspace's only number is used (quoSender). */
  fromNumber: string | null;
};

/** Why Quo cannot be used by this workspace at all: no key, or a saved key that cannot be read. */
export class QuoError extends Error {
  readonly code: "missing_credentials" | "credentials_unreadable";
  readonly status: number;
  constructor(code: QuoError["code"], message: string, status: number) {
    super(message);
    this.name = "QuoError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The workspace's Quo key and From number from the shared key store: a saved
 * value first, then OASIS's own server values for OASIS's own workspaces only
 * (QUO_API_KEY, QUO_FROM_E164 in lib/tenant-integration-store.ts ENV_FALLBACKS).
 *
 * Throws QuoError "missing_credentials" when Quo is not set up, and
 * "credentials_unreadable" when a key was saved but cannot be read now. A
 * broken key is an error to fix, never "not set up", so a text is not quietly
 * sent through another provider instead.
 */
export async function getQuoCredentials(tenantId: string): Promise<QuoCredentials> {
  const notSetUp = () =>
    new QuoError("missing_credentials", "Quo is not set up for this workspace. Add the Quo API key in Settings > Connections > Quo.", 400);
  if (!tenantId) throw notSetUp();
  const bundle = await getTenantIntegrationBundle(tenantId, "quo");
  const apiKey = (bundle.api_key ?? "").trim();
  if (!apiKey) {
    // The bundle leaves out a saved key that will not decrypt, and is empty
    // when the lookup failed. Only a key that is truly absent is "not set up".
    const saved = await readTenantCredentialStrict(tenantId, "quo", "api_key");
    if (!saved.ok && saved.reason === "missing") throw notSetUp();
    throw new QuoError(
      "credentials_unreadable",
      "OASIS could not read the saved Quo API key, so nothing was sent. Try again in a minute; if this repeats, save the key again in Settings > Connections > Quo.",
      503,
    );
  }
  return { tenantId, apiKey, fromNumber: (bundle.from_number ?? "").trim() || null };
}

/** getQuoCredentials, with "not set up" as null. A saved key that cannot be read still throws. */
export async function quoCredentialsOrNull(tenantId: string): Promise<QuoCredentials | null> {
  try {
    return await getQuoCredentials(tenantId);
  } catch (err) {
    if (err instanceof QuoError && err.code === "missing_credentials") return null;
    throw err;
  }
}

// -- Results ------------------------------------------------------------------------

export type QuoFailureCode =
  | "tenant_retired"
  | "quo_switched_off"
  | "live_send_disabled"
  | "invalid_recipient"
  | "invalid_text"
  | "recipient_opted_out"
  | "opt_out_check_failed"
  | "no_sender"
  | "quo_refused"
  | "quo_unreachable"
  | "quo_unexpected";

/**
 * The text was not sent, or (quo_unreachable and quo_unexpected on a send)
 * Quo got the request and OASIS cannot tell whether it went out. `status` is
 * Quo's HTTP status, when Quo answered.
 */
export type QuoFailure = { ok: false; code: QuoFailureCode; status?: number; reason: string };

/** The plain reason for a send refused because PROVIDER_QUO_ENABLED is 0. */
export const QUO_SWITCHED_OFF_REASON = "Texting through Quo is switched off on this deployment, so nothing was sent.";

export type QuoSendResult =
  | {
      ok: true;
      /** Quo's message id (AC...): a send counts only when Quo's answer names it. */
      id: string;
      /** Quo's word for the message ("queued", "sent", ...), or "accepted" when its answer gave none. */
      status: string;
      conversationId: string | null;
      /** The number the text left from. */
      from: string;
    }
  | QuoFailure;

export type QuoDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** The HTTP status a route answers for a Quo send that failed. */
export function quoFailureHttpStatus(failure: QuoFailure): number {
  switch (failure.code) {
    case "invalid_recipient":
    case "invalid_text":
    case "no_sender":
      return 400;
    case "recipient_opted_out":
    case "live_send_disabled":
    case "quo_switched_off":
      return 409;
    case "tenant_retired":
      return 410;
    case "opt_out_check_failed":
      return 503;
    default:
      // Quo's own answer, or none: a 429 stays a 429 so the caller can wait.
      return failure.status === 429 ? 429 : 502;
  }
}

// -- Calls --------------------------------------------------------------------------

/** The headers every Quo call sends. Quo takes the raw key in Authorization, with no "Bearer". */
export function quoHeaders(apiKey: string, withBody = false): Record<string, string> {
  return {
    Authorization: apiKey,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...(withBody ? { "Content-Type": "application/json" } : {}),
  };
}

type Fetched = { ok: true; res: Response } | { ok: false };

async function quoFetch(
  path: string,
  request: { method: "GET" | "POST"; apiKey: string; body?: string },
  deps: QuoDeps,
  timeoutMs: number,
): Promise<Fetched> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${QUO_API_BASE}${path}`, {
      method: request.method,
      headers: quoHeaders(request.apiKey, request.body !== undefined),
      body: request.body,
      // A redirect would carry the key with it: never follow one.
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? timeoutMs),
    });
    return { ok: true, res };
  } catch (err) {
    // The error's name only (TimeoutError, TypeError): a message can echo the request.
    console.error("[quo.network]", request.method, path, err instanceof Error ? err.name : "error");
    return { ok: false };
  }
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Cut the key out of a sentence, in case Quo ever echoes it back. */
function withoutKey(sentence: string, apiKey: string): string {
  return apiKey.length >= 8 ? sentence.split(apiKey).join("[key]") : sentence;
}

/**
 * Quo's own words for a refusal: its title and message ("A2P Registration Not
 * Approved: ..."), or a 401's error.message.
 */
async function refusalReason(res: Response, what: string, apiKey: string): Promise<string> {
  const body = await jsonOf(res);
  const nested = body?.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : null;
  const parts = [text(body?.title), text(body?.message), text(nested?.message)].filter(
    (part, i, all): part is string => part !== null && all.indexOf(part) === i,
  );
  let reason = `Quo refused ${what} (HTTP ${res.status})${parts.length > 0 ? `: ${parts.join(": ")}` : ""}`;
  if (!/[.!?]$/.test(reason)) reason += ".";
  if (res.status === 401) reason += " Check the Quo API key in Settings > Connections > Quo.";
  return withoutKey(reason, apiKey);
}

// -- Numbers --------------------------------------------------------------------------

export type QuoRegion = "CA" | "US" | "Intl";
const REGIONS: readonly QuoRegion[] = ["CA", "US", "Intl"];

export type QuoNumber = {
  id: string | null;
  /** E.164, as Quo lists it. */
  number: string;
  name: string | null;
  /** Where the number may text, in Quo's words ("unrestricted" or "restricted"); null when Quo did not say. */
  messaging: Partial<Record<QuoRegion, string>> | null;
};

/** The numbers in a GET /v1/phone-numbers answer, or null when the answer has no list. */
export function quoNumbersFrom(body: unknown): QuoNumber[] | null {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) return null;
  const numbers: QuoNumber[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const number = text(row.number, 20);
    if (!number) continue;
    const restrictions = row.restrictions && typeof row.restrictions === "object" ? (row.restrictions as Record<string, unknown>) : null;
    const where =
      restrictions?.messaging && typeof restrictions.messaging === "object"
        ? (restrictions.messaging as Record<string, unknown>)
        : null;
    let messaging: Partial<Record<QuoRegion, string>> | null = null;
    if (where) {
      messaging = {};
      for (const region of REGIONS) {
        const value = text(where[region], 40);
        if (value) messaging[region] = value;
      }
    }
    numbers.push({ id: text(row.id, 64), number, name: text(row.name, 80), messaging });
  }
  return numbers;
}

/** "+1 365 360 3976" for a North American number; any other number as Quo lists it. */
export function formatQuoNumber(number: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : number;
}

const REGION_NAMES: Readonly<Record<QuoRegion, string>> = { CA: "Canada", US: "US", Intl: "international" };

/**
 * "+1 365 360 3976: Canada yes, US restricted, international restricted".
 * Quo's answer says only "unrestricted" or "restricted" for each region, never
 * why, so the words say no more than that.
 */
export function describeQuoNumber(n: QuoNumber): string {
  const where = REGIONS.filter((region) => n.messaging?.[region]).map((region) => {
    const value = n.messaging![region];
    return `${REGION_NAMES[region]} ${value === "unrestricted" ? "yes" : value === "restricted" ? "restricted" : "unknown"}`;
  });
  const number = formatQuoNumber(n.number);
  return where.length > 0 ? `${number}: ${where.join(", ")}` : `${number}: Quo did not say where it may text`;
}

/** The workspace's only number, or why there is not exactly one. */
export function soleQuoNumber(
  numbers: readonly QuoNumber[],
): { ok: true; number: QuoNumber } | { ok: false; code: "no_number" | "needs_number"; reason: string } {
  if (numbers.length === 1) return { ok: true, number: numbers[0] };
  if (numbers.length === 0) {
    return { ok: false, code: "no_number", reason: "This Quo workspace has no phone number, so there is nothing to text from. Add a number in Quo." };
  }
  return {
    ok: false,
    code: "needs_number",
    reason: `This Quo workspace has ${numbers.length} numbers. Save the one texts leave from as the From number in Settings > Connections > Quo.`,
  };
}

/** GET /v1/phone-numbers: the workspace's numbers and where each may text. Sends nothing. */
export async function listQuoNumbers(
  apiKey: string,
  deps: QuoDeps = {},
): Promise<{ ok: true; numbers: QuoNumber[] } | QuoFailure> {
  const r = await quoFetch("/phone-numbers", { method: "GET", apiKey }, deps, LIST_TIMEOUT_MS);
  if (!r.ok) {
    return { ok: false, code: "quo_unreachable", reason: "Quo did not answer when OASIS asked for your Quo numbers, so nothing was sent. Try again in a minute." };
  }
  if (r.res.status !== 200) {
    return { ok: false, code: "quo_refused", status: r.res.status, reason: await refusalReason(r.res, "the number list", apiKey) };
  }
  const numbers = quoNumbersFrom(await jsonOf(r.res));
  if (!numbers) {
    return {
      ok: false,
      code: "quo_unexpected",
      status: r.res.status,
      reason: "Quo's answer had no list of numbers, so OASIS could not tell which number to text from. Nothing was sent.",
    };
  }
  return { ok: true, numbers };
}

/**
 * The number a Quo text leaves from: the saved From number, else the
 * workspace's only number. That one is asked of Quo on each send: a dashboard
 * text is one click, so the extra read is cheap and never out of date. A
 * workspace with no number, or several and none chosen, is a failure that
 * says what to do.
 */
export async function quoSender(
  creds: QuoCredentials,
  deps: QuoDeps = {},
): Promise<{ ok: true; number: string; source: "configured" | "workspace" } | QuoFailure> {
  if (creds.fromNumber) return { ok: true, number: creds.fromNumber, source: "configured" };
  const listed = await listQuoNumbers(creds.apiKey, deps);
  if (!listed.ok) return listed;
  const sole = soleQuoNumber(listed.numbers);
  if (!sole.ok) return { ok: false, code: "no_sender", reason: sole.reason };
  return { ok: true, number: sole.number.number, source: "workspace" };
}

/**
 * Is a STOP texted back to the Quo number read by OASIS? Automated texts (the
 * founder-meeting reminders) promise "Reply STOP to opt out", so they are held
 * until it provably is. Both must hold:
 *   - the webhook's signing key is set (QUO_WEBHOOK_SIGNING_KEY), so
 *     app/api/webhooks/quo can authenticate a delivery; and
 *   - that route has recorded a delivery whose signature verified AND whose
 *     message.received sender and text it could read (quo_inbound_health
 *     last_inbound_at): the exact event a STOP arrives as. A STOP then goes
 *     through applyInboundSmsStop, the path the Twilio intake already uses,
 *     and sendQuoSms refuses that number (tests/quo-stop-intake.test.ts).
 * A key alone never opens it (Codex review of #774). A read failure keeps it
 * closed. A person's own reply in Conversations is not automated.
 */
export async function quoStopIntakeConnected(
  tenantId: string,
  /** The number the text would leave from: the proof must be for THIS line (Codex review of #776). */
  senderNumber: string,
  deps: { env?: Readonly<Record<string, string | undefined>>; client?: Pick<Client, "execute"> } = {},
): Promise<boolean> {
  if (!quoWebhookKeyConfigured(deps.env ?? process.env)) return false;
  if (!senderNumber) return false;
  try {
    const result = await (deps.client ?? getTursoClient()).execute({
      sql: "SELECT last_inbound_at, last_inbound_to FROM quo_inbound_health WHERE tenant_id = ? LIMIT 1",
      args: [tenantId],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const digits = (value: unknown) => (typeof value === "string" ? value.replace(/\D/g, "") : "");
    return (
      typeof row?.last_inbound_at === "string" &&
      row.last_inbound_at.length > 0 &&
      digits(row.last_inbound_to).length >= 10 &&
      digits(row.last_inbound_to) === digits(senderNumber)
    );
  } catch (error) {
    console.error("[quo] STOP intake check failed; automated texts stay off", error instanceof Error ? error.message : error);
    return false;
  }
}

// -- Sending --------------------------------------------------------------------------

/**
 * Send one text through Quo. Never throws for a refusal or a network failure:
 * the answer says what happened, in Quo's words when Quo gave them.
 *
 * In order, before anything reaches Quo:
 *   - a retired workspace sends nothing (lib/tenant/retired.ts);
 *   - Quo's own switch, PROVIDER_QUO_ENABLED (providerSwitchedOn in
 *     lib/routing/provider-availability.ts, the switch routing reads for
 *     every provider): at 0, nothing goes out through Quo;
 *   - the live-send switch, here at the send itself as Twilio's direct send
 *     does it (LIVE_SEND_QUO, lib/integrations/send-mode.ts): callers check it
 *     first, and one that forgets still sends nothing;
 *   - the number must be E.164 and the text 1 to 1600 characters;
 *   - the workspace's STOP list (checkPhoneOptOut). A Quo text never passes
 *     send_gateway's do-not-text list, so the check runs here, and a list that
 *     cannot be read stops the send (CASL / TCPA). The list holds the STOPs
 *     that reached OASIS (the TextTorrent and Twilio webhooks,
 *     lib/sms-opt-out.ts). Replies to the Quo number, STOP included, are not
 *     read by OASIS yet, so a STOP texted to the Quo number is not on it.
 */
export async function sendQuoSms(
  creds: QuoCredentials,
  input: { to: string; text: string },
  deps: QuoDeps = {},
): Promise<QuoSendResult> {
  if (isRetiredTenant(creds.tenantId)) {
    return { ok: false, code: "tenant_retired", reason: "This workspace is retired, so OASIS sends no texts for it." };
  }
  if (!providerSwitchedOn("quo")) {
    return { ok: false, code: "quo_switched_off", reason: QUO_SWITCHED_OFF_REASON };
  }
  if (isDryRun("quo")) {
    return { ok: false, code: "live_send_disabled", reason: "Live texting through Quo is switched off, so nothing was sent." };
  }
  const to = (input.to ?? "").trim();
  if (!E164.test(to)) {
    return { ok: false, code: "invalid_recipient", reason: "The number to text must be in E.164 form, like +14165551212." };
  }
  const message = (input.text ?? "").trim();
  if (!message) return { ok: false, code: "invalid_text", reason: "There is no text to send." };
  if (message.length > QUO_MAX_TEXT) {
    return { ok: false, code: "invalid_text", reason: `Quo sends at most ${QUO_MAX_TEXT} characters in one text.` };
  }
  const optOut = await checkPhoneOptOut(creds.tenantId, to);
  if (optOut.optedOut) {
    return { ok: false, code: "recipient_opted_out", reason: "This number is on the workspace's STOP list, so OASIS will not text it." };
  }
  if (optOut.checkFailed) {
    return {
      ok: false,
      code: "opt_out_check_failed",
      reason: "OASIS could not read the workspace's STOP list, so nothing was sent. Try again in a minute.",
    };
  }

  const sender = await quoSender(creds, deps);
  if (!sender.ok) return sender;

  const r = await quoFetch(
    "/messages",
    { method: "POST", apiKey: creds.apiKey, body: JSON.stringify({ content: message, from: sender.number, to: [to] }) },
    deps,
    SEND_TIMEOUT_MS,
  );
  if (!r.ok) {
    return {
      ok: false,
      code: "quo_unreachable",
      reason: "Quo did not answer, so OASIS cannot tell whether the text went out. Check the conversation in Quo before sending it again.",
    };
  }
  if (r.res.status < 200 || r.res.status >= 300) {
    const reason = await refusalReason(r.res, "the text", creds.apiKey);
    console.error("[quo.send] refused", r.res.status);
    return { ok: false, code: "quo_refused", status: r.res.status, reason };
  }
  const data = (await jsonOf(r.res))?.data;
  const sent = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const id = text(sent?.id, 128);
  if (!id) {
    // A 2xx that does not name the message it made (an empty body, HTML, {},
    // []) proves nothing: Quo may or may not have sent it.
    console.error("[quo.send] answered without a message id", r.res.status);
    return {
      ok: false,
      code: "quo_unexpected",
      status: r.res.status,
      reason:
        "Quo answered without naming the text it sent, so OASIS cannot tell whether the text went out. Check the conversation in Quo before sending it again.",
    };
  }
  return {
    ok: true,
    id,
    status: text(sent?.status, 40) ?? "accepted",
    conversationId: text(sent?.conversationId, 128),
    from: sender.number,
  };
}
