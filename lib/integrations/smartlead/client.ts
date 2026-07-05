/**
 * Smartlead API client (server-only). Cold-email sending backend for SunBiz — the
 * dashboard stays the source of truth for templates + suppression; Smartlead is the
 * "dumb sender" that owns warmed mailboxes + deliverability.
 *
 * Auth: Smartlead takes the API key as a QUERY PARAM (?api_key=...) — weaker than a
 * Bearer header, so this MUST only ever run server-side (route handlers), never in
 * client code, and the key lives in a Vercel env var. Base + endpoints verified
 * against api.smartlead.ai (2026-07). Fails CLOSED (429/!ok → throw; caller alerts).
 */
import "server-only";

const API = "https://server.smartlead.ai/api/v1";

export class SmartleadClient {
  constructor(private apiKey: string) {}

  private async req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${API}${path}${sep}api_key=${encodeURIComponent(this.apiKey)}`;
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 429) throw new Error("Smartlead rate limited (429) — back off and retry"); // fail closed
    if (!r.ok) throw new Error(`Smartlead ${method} ${path} → ${r.status} ${await r.text().catch(() => "")}`);
    return (r.status === 204 ? (undefined as T) : r.json());
  }

  // ── Email accounts / mailboxes ───────────────────────────────────────────────
  listEmailAccounts() { return this.req("GET", "/email-accounts"); }
  getWarmupStats(emailAccountId: string | number) { return this.req("GET", `/email-accounts/${encodeURIComponent(String(emailAccountId))}/warmup-stats`); }
  updateEmailAccount(id: string | number, patch: Record<string, unknown>) { return this.req("PATCH", `/email-accounts/${encodeURIComponent(String(id))}`, patch); }

  // ── Campaigns ────────────────────────────────────────────────────────────────
  listCampaigns() { return this.req("GET", "/campaigns/"); }
  getCampaign(id: string | number) { return this.req("GET", `/campaigns/${encodeURIComponent(String(id))}`); }
  createCampaign(body: Record<string, unknown>) { return this.req("POST", "/campaigns/create", body); }
  /** status ∈ ACTIVE | PAUSED | STOPPED */
  setCampaignStatus(id: string | number, status: "ACTIVE" | "PAUSED" | "STOPPED") { return this.req("PATCH", `/campaigns/${encodeURIComponent(String(id))}/status`, { status }); }
  updateCampaignSettings(id: string | number, settings: Record<string, unknown>) { return this.req("PATCH", `/campaigns/${encodeURIComponent(String(id))}/settings`, settings); }
  setCampaignSchedule(id: string | number, schedule: Record<string, unknown>) { return this.req("POST", `/campaigns/${encodeURIComponent(String(id))}/schedule`, schedule); }
  saveSequence(id: string | number, sequences: unknown) { return this.req("POST", `/campaigns/${encodeURIComponent(String(id))}/sequences`, { sequences }); }
  linkEmailAccounts(id: string | number, emailAccountIds: (string | number)[]) { return this.req("POST", `/campaigns/${encodeURIComponent(String(id))}/email-accounts`, { email_account_ids: emailAccountIds }); }
  /** Max 400 leads per request. */
  addLeads(id: string | number, leadList: Record<string, unknown>[], settings?: Record<string, unknown>) { return this.req("POST", `/campaigns/${encodeURIComponent(String(id))}/leads`, { lead_list: leadList.slice(0, 400), settings }); }
  getCampaignAnalytics(id: string | number) { return this.req("GET", `/campaigns/${encodeURIComponent(String(id))}/analytics`); }
  getCampaignLeads(id: string | number, offset = 0, limit = 100) { return this.req("GET", `/campaigns/${encodeURIComponent(String(id))}/leads?offset=${offset}&limit=${limit}`); }

  // ── Webhooks ─────────────────────────────────────────────────────────────────
  listWebhooks() { return this.req("GET", "/webhooks"); }
  createWebhook(body: Record<string, unknown>) { return this.req("POST", "/webhooks", body); }
  deleteWebhook(id: string | number) { return this.req("DELETE", `/webhooks/${encodeURIComponent(String(id))}`); }
}

/** Client from the env key, or null if not configured (fail-closed: no key → no sends). */
export function getSmartleadClient(): SmartleadClient | null {
  const key = (process.env.SMARTLEAD_API_KEY || "").trim();
  return key ? new SmartleadClient(key) : null;
}
