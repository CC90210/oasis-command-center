/** Independent from the business cron Worker and VPS. Its Durable Object keeps
 * outage/delivery state even while the app or its database is unavailable. */
interface Storage { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }
interface State { storage: Storage; blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T> }
interface Namespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
export interface Env {
  OBSERVER: Namespace; OBSERVER_ENABLED?: string; APP_ORIGIN?: string;
  CRON_SECRET?: string; AUTOMATION_OBSERVER_ATTEST_SECRET?: string;
  OASIS_TELEGRAM_BOT_TOKEN?: string; OASIS_TELEGRAM_CHAT_ID?: string;
}
export type Incident = { samples: boolean[]; open: boolean; delivered: boolean; delivery: "none" | "sending" | "delivered" | "refused" | "permanent_failure" | "delivery_unknown"; lastAttempt: number; openedAt: number | null;
  retryAt?: number; receipts?: { alert?: number; recovery?: number }; deliveryError?: string | null };
export function nextIncident(previous: Incident | undefined, healthy: boolean, now: number): Incident {
  const state = previous ?? { samples: [], open: false, delivered: false, delivery: "none", lastAttempt: 0, openedAt: null };
  const samples = [...state.samples.slice(-5), healthy];
  const bad = !healthy && ((samples.length >= 2 && samples.slice(-2).every((s) => !s)) || samples.filter((s) => !s).length >= 3);
  return { ...state, samples, open: state.open || bad, openedAt: state.openedAt ?? (bad ? now : null), delivery: state.delivery === "sending" ? "delivery_unknown" : state.delivery };
}

export class ObserverIncident {
  constructor(private state: State, private env: Env) {}
  async fetch(): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const previous = await this.state.storage.get<Incident>("incident");
      let healthy = false;
      try {
        if (!this.env.CRON_SECRET || !this.env.AUTOMATION_OBSERVER_ATTEST_SECRET) throw new Error("observer_auth_missing");
        const response = await fetch(`${this.env.APP_ORIGIN || "https://oasisai.work"}/api/cron/automation-observer`, {
          headers: { authorization: `Bearer ${this.env.CRON_SECRET}`, "x-oasis-observer-attest": this.env.AUTOMATION_OBSERVER_ATTEST_SECRET, "x-oasis-observer-delivery": previous?.delivery ?? "none", "user-agent": "oasis-automation-observer/1.0" },
          signal: AbortSignal.timeout(20_000),
        });
        const body = await response.json() as { ok?: boolean; status?: string };
        healthy = response.ok && body.ok === true && body.status === "observed";
      } catch { /* Fixed incident text only; no upstream response/credential logging. */ }
      let current = nextIncident(previous, healthy, now);
      await this.state.storage.put("incident", current);
      const recovered = current.open && current.samples.length >= 2 && current.samples.slice(-2).every(Boolean);
      const held = ["delivery_unknown", "permanent_failure"].includes(current.delivery);
      const due = current.open && (!healthy || recovered) && !held && now >= Math.max(current.lastAttempt + 5 * 60_000, current.retryAt ?? 0);
      if (due && ((!recovered && !current.delivered) || (recovered && current.delivered))) {
        current = { ...current, delivery: "sending", lastAttempt: now };
        await this.state.storage.put("incident", current);
        const text = recovered
          ? "Automation observer recovered: two consecutive complete checks reached the app and its durable results."
          : "Automation observer cannot verify the systems: the app, database, or alert delivery has failed repeated independent checks. Open Command Center health; no green system claim is available.";
        let delivery: Incident["delivery"] = "permanent_failure";
        let deliveryError: string | null = "observer_telegram_credentials_missing";
        let providerMessageId: number | undefined;
        let retryAt = 0;
        if (this.env.OASIS_TELEGRAM_BOT_TOKEN && this.env.OASIS_TELEGRAM_CHAT_ID) {
          try {
            const response = await fetch(`https://api.telegram.org/bot${this.env.OASIS_TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: this.env.OASIS_TELEGRAM_CHAT_ID, text }), signal: AbortSignal.timeout(5_000),
            });
            const receipt = await response.json().catch(() => null) as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number }; result?: { message_id?: number } } | null;
            const code = receipt?.ok === false && Number.isInteger(receipt.error_code) ? receipt.error_code! : response.status;
            if (response.ok && receipt?.ok === true && Number.isSafeInteger(receipt.result?.message_id) && receipt.result!.message_id! > 0) {
              delivery = "delivered"; providerMessageId = receipt.result!.message_id; deliveryError = null;
            } else if (code === 429) {
              const header = response.headers.get("retry-after");
              const parsedHeader = header && /^\d+$/.test(header) ? Number(header) : header ? (Date.parse(header) - now) / 1000 : 0;
              const seconds = Math.max(300, Number(receipt?.parameters?.retry_after) || 0, Number.isFinite(parsedHeader) ? parsedHeader : 0);
              retryAt = now + (Number.isFinite(seconds) ? seconds : 300) * 1000;
              delivery = "refused"; deliveryError = "telegram_rate_limited";
            } else if (code >= 400 && code < 500 && code !== 408) {
              delivery = "permanent_failure"; deliveryError = `telegram_http_${code}`;
            } else {
              delivery = "delivery_unknown"; deliveryError = "telegram_receipt_unverified";
            }
          } catch { delivery = "delivery_unknown"; deliveryError = "telegram_transport_unknown"; }
        }
        const receipts = { ...current.receipts, ...(providerMessageId ? { [recovered ? "recovery" : "alert"]: providerMessageId } : {}) };
        current = { ...current, delivery, deliveryError, retryAt, receipts, delivered: recovered ? current.delivered : delivery === "delivered" };
        if (recovered && delivery === "delivered") current = { samples: [true, true], open: false, delivered: false, delivery: "none", lastAttempt: now, openedAt: null, receipts };
        await this.state.storage.put("incident", current);
      } else if (recovered && !current.delivered && !held) {
        current = { samples: [true, true], open: false, delivered: false, delivery: "none", lastAttempt: now, openedAt: null, receipts: current.receipts };
        await this.state.storage.put("incident", current);
      }
      console.log(JSON.stringify({ observer: healthy ? "observed" : "unverified", incident_open: current.open, delivery: current.delivery }));
      return Response.json({ ok: healthy, incident_open: current.open, delivery: current.delivery });
    });
  }
}

const worker = {
  fetch(): Response { return new Response("oasis-automation-observer", { status: 200 }); },
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    if (env.OBSERVER_ENABLED !== "on") return;
    const stub = env.OBSERVER.get(env.OBSERVER.idFromName("oasis-operator-automation-health"));
    ctx.waitUntil(stub.fetch(new Request("https://observer.internal/tick")).then((r) => r.body?.cancel()));
  },
};
export default worker;
