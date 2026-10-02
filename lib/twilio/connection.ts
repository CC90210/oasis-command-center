/**
 * lib/twilio/connection.ts - one workspace's own Twilio account: how OASIS
 * authenticates to it, the read-only connection test, and the one write an
 * owner can ask for (pointing their number at OASIS's webhooks).
 *
 * WHOSE ACCOUNT. Every call here uses the bundle the caller passes in, which is
 * the workspace's own (lib/tenant-integration-store.ts getTenantIntegrationBundle
 * gives OASIS's env account to OASIS's own tenants only). Nothing here reads an
 * env var, so one workspace can never test, send or reconfigure through another
 * workspace's Twilio account.
 *
 * AUTH. An API key (SK... + secret) when both are saved, otherwise the Auth
 * Token, always against the Account SID in the URL. Twilio signs every webhook
 * with the ACCOUNT'S AUTH TOKEN, never an API key secret, so a workspace with
 * only an API key can send but OASIS cannot verify its incoming texts: the
 * inbound route refuses them, and pointTwilioWebhooksAtOasis refuses to point a
 * number at OASIS until the Auth Token is saved.
 *
 * THE TEST IS READ-ONLY: GETs of the account, its numbers and the messaging
 * service. No message is sent, nothing is bought or changed. Every request has a
 * deadline that covers the body, and a Twilio that does not answer is
 * "unreachable", never a verdict on the keys.
 */
import "server-only";
import { isTwilioTestState, type TwilioTestState } from "@/lib/twilio/shared";

export const TWILIO_API = "https://api.twilio.com/2010-04-01";
export const TWILIO_MESSAGING_API = "https://messaging.twilio.com/v1";
export const TWILIO_PROBE_TIMEOUT_MS = 8_000;

export type TwilioBundle = {
  account_sid?: string;
  auth_token?: string;
  api_key_sid?: string;
  api_key_secret?: string;
  from_number?: string;
  messaging_service_sid?: string;
};

export type TwilioAuth = { accountSid: string; username: string; password: string; via: "api_key" | "auth_token" };

const clean = (v: string | undefined) => (v || "").trim();

/** How OASIS authenticates to this workspace's Twilio, or null when the keys are incomplete. */
export function twilioAuthFor(bundle: TwilioBundle): TwilioAuth | null {
  const accountSid = clean(bundle.account_sid);
  if (!accountSid) return null;
  const keySid = clean(bundle.api_key_sid);
  const keySecret = clean(bundle.api_key_secret);
  if (keySid && keySecret) return { accountSid, username: keySid, password: keySecret, via: "api_key" };
  const token = clean(bundle.auth_token);
  if (token) return { accountSid, username: accountSid, password: token, via: "auth_token" };
  return null;
}

export function twilioAuthHeader(auth: TwilioAuth): string {
  return "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
}

/** Can OASIS verify X-Twilio-Signature for this workspace? Only with its Auth Token. */
export function twilioInboundVerifiable(bundle: TwilioBundle): boolean {
  return clean(bundle.auth_token).length > 0;
}

export type TwilioSender = { kind: "messaging_service"; sid: string } | { kind: "number"; number: string };

/** The sender OASIS sends from: the messaging service wins, as in buildTwilioMessageForm. */
export function twilioSenderOf(bundle: TwilioBundle): TwilioSender | null {
  const mg = clean(bundle.messaging_service_sid);
  if (mg) return { kind: "messaging_service", sid: mg };
  const number = clean(bundle.from_number);
  return number ? { kind: "number", number } : null;
}

// -- HTTP, with a deadline over the whole exchange --------------------------

type Fetch = typeof fetch;
type Reply = { status: number; body: Record<string, unknown> | null };
/** No answer at all (network error or deadline): status 0. */
const NO_ANSWER = 0;

async function twilioCall(
  fetchImpl: Fetch,
  auth: TwilioAuth,
  timeoutMs: number,
  method: "GET" | "POST",
  url: string,
  form?: URLSearchParams,
): Promise<Reply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Reply>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: NO_ANSWER, body: null });
    }, timeoutMs);
  });
  const exchange = (async (): Promise<Reply> => {
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: twilioAuthHeader(auth),
          Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? form.toString() : undefined,
        signal: controller.signal,
      });
      const parsed = (await res.json().catch(() => null)) as unknown;
      const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      return { status: res.status, body };
    } catch {
      return { status: NO_ANSWER, body: null };
    }
  })();
  try {
    return await Promise.race([exchange, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const digits = (v: string) => v.replace(/\D/g, "");

/** IncomingPhoneNumbers capabilities: {"sms": true, ...} (either key case). */
function canText(n: Record<string, unknown>): boolean {
  const caps = n.capabilities;
  if (!caps || typeof caps !== "object") return false;
  const c = caps as Record<string, unknown>;
  return c.sms === true || c.SMS === true;
}

// -- The connection test ----------------------------------------------------

export type TwilioWebhookState = "oasis" | "elsewhere" | "unset";

export type TwilioProbe = {
  state: TwilioTestState;
  ok: boolean;
  /** One plain sentence for the owner, the same words the card will show. */
  message: string;
  account: { name: string | null; status: string | null; trial: boolean } | null;
  sender:
    | { kind: "number"; number: string; incoming: TwilioWebhookState }
    | { kind: "messaging_service"; sid: string; name: string | null; senders: number; incoming: TwilioWebhookState; delivery: TwilioWebhookState }
    | null;
  /** SMS-capable numbers on the account when none is saved as the sender (up to 5). */
  ownedNumbers: string[];
  /** False with only an API key: incoming texts cannot be verified. */
  inboundVerifiable: boolean;
  /** Twilio's HTTP status on an unreachable answer, for the message. */
  httpStatus?: number;
};

export type TwilioProbeOptions = {
  fetchImpl?: Fetch;
  timeoutMs?: number;
  /** OASIS's webhook URLs, to say whether the number already points at OASIS. */
  webhookUrls?: { inbound: string; status: string };
};

function webhookState(current: string | null, ours: string | undefined): TwilioWebhookState {
  if (!current) return "unset";
  return ours && current === ours ? "oasis" : "elsewhere";
}

const REJECTED =
  "Credentials rejected. Twilio did not accept this Account SID with the saved Auth Token or API key.";

/**
 * Test a workspace's Twilio keys with read-only calls and say, in one plain
 * state, whether OASIS can text from it: connected, needs a number, number
 * cannot send texts, credentials rejected (plus account not active, messaging
 * service not found, incomplete keys, and Twilio not answering).
 */
export async function probeTwilioConnection(bundle: TwilioBundle, opts: TwilioProbeOptions = {}): Promise<TwilioProbe> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TWILIO_PROBE_TIMEOUT_MS;
  const inboundVerifiable = twilioInboundVerifiable(bundle);
  const out = (state: TwilioTestState, message: string, extra: Partial<TwilioProbe> = {}): TwilioProbe => ({
    state,
    ok: state === "connected",
    message,
    account: null,
    sender: null,
    ownedNumbers: [],
    inboundVerifiable,
    ...extra,
  });
  const auth = twilioAuthFor(bundle);
  if (!auth) {
    return out("incomplete", "Add the Account SID and either the Auth Token or an API key (its SID and secret) first.");
  }
  const call = (method: "GET" | "POST", url: string) => twilioCall(fetchImpl, auth, timeoutMs, method, url);
  const unreachable = (status: number) =>
    out("unreachable", `Twilio did not answer${status ? ` (HTTP ${status})` : ""}. Nothing was changed; run Test again.`, { httpStatus: status });
  const base = `${TWILIO_API}/Accounts/${encodeURIComponent(auth.accountSid)}`;

  // 1. The account. A Standard API key may not read the account resource
  //    itself (Twilio error 20003): the next read decides whether it works.
  let account: TwilioProbe["account"] = null;
  const acct = await call("GET", `${base}.json`);
  if (acct.status === 200) {
    const status = str(acct.body?.status);
    account = { name: str(acct.body?.friendly_name), status, trial: str(acct.body?.type)?.toLowerCase() === "trial" };
    if (status && status !== "active") {
      return out("account_inactive", `Twilio account not active. Twilio reports this account as ${status}.`, { account });
    }
  } else if (acct.status === 401 || acct.status === 403) {
    if (auth.via === "auth_token") return out("credentials_rejected", REJECTED);
  } else if (acct.status === 404) {
    return out("credentials_rejected", "Credentials rejected. Twilio has no account with this Account SID for these credentials.");
  } else {
    return unreachable(acct.status);
  }
  const trialNote = account?.trial ? " This is a Twilio trial account: it can only text numbers verified in Twilio." : "";
  const sender = twilioSenderOf(bundle);

  // 2a. A messaging service sends from its sender pool.
  if (sender?.kind === "messaging_service") {
    const svcUrl = `${TWILIO_MESSAGING_API}/Services/${encodeURIComponent(sender.sid)}`;
    const svc = await call("GET", svcUrl);
    if (svc.status === 401 || svc.status === 403) return out("credentials_rejected", REJECTED, { account });
    if (svc.status === 404) {
      return out("messaging_service_not_found", `Messaging service not found. Twilio has no messaging service ${sender.sid} on this account.`, { account });
    }
    if (svc.status !== 200) return unreachable(svc.status);
    const name = str(svc.body?.friendly_name);
    let senders = 0;
    for (const [path, key] of [["PhoneNumbers", "phone_numbers"], ["ShortCodes", "short_codes"], ["AlphaSenders", "alpha_senders"]] as const) {
      const pool = await call("GET", `${svcUrl}/${path}?PageSize=20`);
      if (pool.status === 401 || pool.status === 403) return out("credentials_rejected", REJECTED, { account });
      if (pool.status !== 200) return unreachable(pool.status);
      senders += list(pool.body?.[key]).length;
      if (senders > 0) break;
    }
    const described = {
      kind: "messaging_service" as const,
      sid: sender.sid,
      name,
      senders,
      incoming: webhookState(str(svc.body?.inbound_request_url), opts.webhookUrls?.inbound),
      delivery: webhookState(str(svc.body?.status_callback), opts.webhookUrls?.status),
    };
    if (senders === 0) {
      return out(
        "needs_number",
        `Needs a number. Messaging service ${name ?? sender.sid} has no sender yet: add a phone number to its sender pool in Twilio, then run Test again.`,
        { account, sender: described },
      );
    }
    return out("connected", `Connected. Messaging service ${name ?? sender.sid} can send texts.${trialNote}`, { account, sender: described });
  }

  // 2b. A phone number (or none saved yet). This read also proves an API key.
  const numbersUrl = new URL(`${base}/IncomingPhoneNumbers.json`);
  numbersUrl.searchParams.set("PageSize", "20");
  if (sender) numbersUrl.searchParams.set("PhoneNumber", sender.number);
  const numbers = await call("GET", numbersUrl.toString());
  if (numbers.status === 401 || numbers.status === 403 || numbers.status === 404) return out("credentials_rejected", REJECTED, { account });
  if (numbers.status !== 200) return unreachable(numbers.status);
  const owned = list(numbers.body?.incoming_phone_numbers);

  if (!sender) {
    const textable = owned.filter(canText).map((n) => str(n.phone_number)).filter((n): n is string => !!n);
    if (textable.length === 0) {
      return out(
        "needs_number",
        "Needs a number. This Twilio account has no phone number that can text yet: buy one in Twilio (Phone Numbers, Buy a number), save it here as the From Number, then run Test again.",
        { account },
      );
    }
    const shown = textable.slice(0, 5);
    return out(
      "needs_number",
      `Needs a number. Save one of this account's numbers as the From Number: ${shown.join(", ")}${textable.length > shown.length ? ", ..." : ""}.`,
      { account, ownedNumbers: shown },
    );
  }

  const match = owned.find((n) => digits(str(n.phone_number) ?? "") === digits(sender.number)) ?? null;
  if (!match) {
    return out("needs_number", `Needs a number. ${sender.number} is not a phone number on this Twilio account.`, { account });
  }
  const described = {
    kind: "number" as const,
    number: str(match.phone_number) ?? sender.number,
    incoming: webhookState(str(match.sms_url), opts.webhookUrls?.inbound),
  };
  if (!canText(match)) {
    return out("number_lacks_sms", `Number cannot send texts. ${described.number} is on this account, but Twilio lists it without SMS.`, {
      account,
      sender: described,
    });
  }
  return out("connected", `Connected. ${described.number} can send texts from this Twilio account.${trialNote}`, { account, sender: described });
}

// -- The one write: point the sender's webhooks at OASIS --------------------

export type TwilioWebhookResult =
  | { ok: true; target: "number" | "messaging_service"; label: string; message: string }
  | {
      ok: false;
      error: TwilioTestState | "auth_token_required";
      message: string;
    };

/**
 * Set OASIS's webhook URLs on the workspace's own sender, on an explicit click
 * (never automatically):
 *   - a phone number: its incoming-message URL (SmsUrl, POST). Delivery updates
 *     for texts OASIS sends ride on each message (StatusCallback), so nothing
 *     else on the number changes;
 *   - a messaging service: its InboundRequestUrl (POST) and StatusCallback.
 * Refused without the Auth Token: Twilio would then deliver texts OASIS cannot
 * verify, and the inbound route refuses every one of them.
 */
export async function pointTwilioWebhooksAtOasis(
  bundle: TwilioBundle,
  urls: { inbound: string; status: string },
  opts: { fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<TwilioWebhookResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TWILIO_PROBE_TIMEOUT_MS;
  const auth = twilioAuthFor(bundle);
  if (!auth) return { ok: false, error: "incomplete", message: "Add the Account SID and the Auth Token first." };
  if (!twilioInboundVerifiable(bundle)) {
    return {
      ok: false,
      error: "auth_token_required",
      message: "Save the Auth Token first: Twilio signs every incoming text with it, and OASIS refuses any text it cannot verify.",
    };
  }
  const sender = twilioSenderOf(bundle);
  if (!sender) {
    return { ok: false, error: "needs_number", message: "Save a From Number or a Messaging Service SID first: there is nothing in Twilio to point at OASIS yet." };
  }
  const fail = (status: number, notFound: { error: TwilioTestState; message: string }): TwilioWebhookResult => {
    if (status === 401 || status === 403) return { ok: false, error: "credentials_rejected", message: REJECTED };
    if (status === 404) return { ok: false, ...notFound };
    return { ok: false, error: "unreachable", message: `Twilio did not answer${status ? ` (HTTP ${status})` : ""}. Nothing was changed; try again.` };
  };

  if (sender.kind === "messaging_service") {
    const form = new URLSearchParams({ InboundRequestUrl: urls.inbound, InboundMethod: "POST", StatusCallback: urls.status });
    const res = await twilioCall(fetchImpl, auth, timeoutMs, "POST", `${TWILIO_MESSAGING_API}/Services/${encodeURIComponent(sender.sid)}`, form);
    if (res.status !== 200) {
      return fail(res.status, { error: "messaging_service_not_found", message: `Twilio has no messaging service ${sender.sid} on this account.` });
    }
    const label = str(res.body?.friendly_name) ?? sender.sid;
    const perNumber = res.body?.use_inbound_webhook_on_number === true;
    return {
      ok: true,
      target: "messaging_service",
      label,
      message:
        `Messaging service ${label} now sends incoming texts and delivery updates to OASIS.` +
        (perNumber
          ? " It is set to use each number's own incoming URL, so turn that off in Twilio (the service's Integration settings) for replies to reach OASIS."
          : ""),
    };
  }

  const base = `${TWILIO_API}/Accounts/${encodeURIComponent(auth.accountSid)}`;
  const lookup = new URL(`${base}/IncomingPhoneNumbers.json`);
  lookup.searchParams.set("PhoneNumber", sender.number);
  lookup.searchParams.set("PageSize", "1");
  const found = await twilioCall(fetchImpl, auth, timeoutMs, "GET", lookup.toString());
  if (found.status !== 200) return fail(found.status, { error: "credentials_rejected", message: REJECTED });
  const pn = list(found.body?.incoming_phone_numbers).find((n) => digits(str(n.phone_number) ?? "") === digits(sender.number));
  const pnSid = pn ? str(pn.sid) : null;
  if (!pn || !pnSid || !/^PN[0-9a-fA-F]{32}$/.test(pnSid)) {
    return { ok: false, error: "needs_number", message: `${sender.number} is not a phone number on this Twilio account.` };
  }
  const form = new URLSearchParams({ SmsUrl: urls.inbound, SmsMethod: "POST" });
  const res = await twilioCall(fetchImpl, auth, timeoutMs, "POST", `${base}/IncomingPhoneNumbers/${pnSid}.json`, form);
  if (res.status !== 200) return fail(res.status, { error: "needs_number", message: `${sender.number} is not a phone number on this Twilio account.` });
  const label = str(res.body?.phone_number) ?? sender.number;
  return {
    ok: true,
    target: "number",
    label,
    message: `${label} now sends incoming texts to OASIS. Delivery updates come back on each text OASIS sends from it.`,
  };
}

/** A stored last_test_error read back as a state, or null for anything else. */
export function twilioStateFromStored(error: string | null | undefined): TwilioTestState | null {
  return isTwilioTestState(error) ? error : null;
}
