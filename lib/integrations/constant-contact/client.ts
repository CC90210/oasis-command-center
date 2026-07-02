/**
 * Constant Contact V3 API client (server-only). Adapted verbatim from
 * knowledge_base/constant-contact/constant-contact-client.ts, verified against
 * AppConnect V3 v3.0.161.
 *
 * Security posture: refresh fails CLOSED (throws → caller alerts + re-auths, never
 * silently proceeds). Run html_content/subject through the SunBiz blast-safety
 * guard (lender-name + em-dash) BEFORE createCampaign — wire it via the `guard`
 * hook in createAndSendBlast.
 */
import "server-only";

const API = "https://api.cc.email/v3";
const AUTHZ = "https://authz.constantcontact.com/oauth2/default/v1";

export interface CCTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms; refresh when within ~2 min
}

/** Token store the host app implements (persist encrypted, e.g. tenant_integration_credentials). */
export interface TokenStore {
  load(): Promise<CCTokens | null>;
  save(t: CCTokens): Promise<void>;
}

// ── OAuth (Authorization Code — confidential client) ─────────────────────────
// No PKCE: this app is a confidential client (has a client_secret), so the secret
// provides code-exchange security. Dropping PKCE removes the verifier cookie, so
// /authorize sets NO cookies and can never interfere with the Supabase session.
export function buildAuthorizeUrl(o: {
  clientId: string; redirectUri: string; scopes: string[]; state: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code", client_id: o.clientId, redirect_uri: o.redirectUri,
    scope: [...o.scopes, "offline_access"].join(" "), state: o.state,
  });
  return `${AUTHZ}/authorize?${q}`;
}

export async function exchangeCode(o: {
  clientId: string; clientSecret: string; code: string; redirectUri: string;
}): Promise<CCTokens> {
  return tokenRequest(o.clientId, o.clientSecret, {
    grant_type: "authorization_code", code: o.code,
    redirect_uri: o.redirectUri,
  });
}

async function tokenRequest(clientId: string, clientSecret: string, body: Record<string, string>): Promise<CCTokens> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const r = await fetch(`${AUTHZ}/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!r.ok) throw new Error(`CC token request failed: ${r.status} ${await r.text().catch(() => "")}`);
  const j = (await r.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token, // ROTATES — always persist the new one
    expires_at: Date.now() + (j.expires_in ?? 86400) * 1000,
  };
}

export class ConstantContactClient {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private store: TokenStore,
  ) {}

  /** Valid access token, refreshing (and persisting the rotated refresh token) if needed. Fails CLOSED. */
  private async accessToken(): Promise<string> {
    const t = await this.store.load();
    if (!t) throw new Error("Constant Contact not connected (no tokens). Run the OAuth connect flow.");
    if (Date.now() < t.expires_at - 120_000) return t.access_token;
    let refreshed: CCTokens;
    try {
      refreshed = await tokenRequest(this.clientId, this.clientSecret, {
        grant_type: "refresh_token", refresh_token: t.refresh_token,
      });
    } catch (e) {
      throw new Error(`CC token refresh failed — reconnect required: ${(e as Error).message}`);
    }
    await this.store.save(refreshed);
    return refreshed.access_token;
  }

  private async req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 429) throw new Error("CC rate limited (429) — back off and retry"); // fail closed
    if (!r.ok) throw new Error(`CC ${method} ${path} → ${r.status} ${await r.text().catch(() => "")}`);
    return (r.status === 204 ? (undefined as T) : r.json());
  }

  // ── Account / sender ───────────────────────────────────────────────────────
  getSenderEmails() { return this.req("GET", "/account/emails"); }
  getAccountSummary() { return this.req("GET", "/account/summary"); }

  // ── Audience ───────────────────────────────────────────────────────────────
  getContactLists() { return this.req("GET", "/contact_lists?limit=100"); }
  createList(name: string, description = "") {
    return this.req("POST", "/contact_lists", { name, description });
  }
  /** Bulk import (async). Returns { activity_id }; poll waitForActivity(). */
  importContacts(importData: unknown[], listIds: string[]) {
    return this.req("POST", "/activities/contacts_json_import", { import_data: importData, list_ids: listIds });
  }
  async waitForActivity(activityId: string, { tries = 30, delayMs = 2000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const a = (await this.req("GET", `/activities/${activityId}`)) as { state?: string; status?: string };
      if (["COMPLETE", "DONE", "ERROR", "CANCELLED"].includes(String(a.state || a.status).toUpperCase())) return a;
      await new Promise((res) => setTimeout(res, delayMs));
    }
    throw new Error(`CC activity ${activityId} did not finish in time`);
  }

  // ── Campaign / blast ───────────────────────────────────────────────────────
  createCampaign(name: string, activity: {
    from_email: string; from_name: string; reply_to_email: string;
    subject: string; html_content: string; preheader?: string;
  }) {
    return this.req("POST", "/emails", {
      name,
      email_campaign_activities: [{ format_type: 5, ...activity }],
    });
  }
  updateActivity(activityId: string, patch: Record<string, unknown>) {
    return this.req("PUT", `/emails/activities/${activityId}`, patch);
  }
  testSend(activityId: string, emails: string[], personalMessage = "Test") {
    return this.req("POST", `/emails/activities/${activityId}/tests`, {
      email_addresses: emails, personal_message: personalMessage,
    });
  }
  /** scheduledDate: '0' = send now; ISO-8601 = send later. */
  schedule(activityId: string, scheduledDate: string) {
    return this.req("POST", `/emails/activities/${activityId}/schedules`, { scheduled_date: scheduledDate });
  }
  tracking(activityId: string, kind: "sends" | "opens" | "unique_opens" | "clicks" | "bounces" | "optouts" | "didnotopens" | "forwards") {
    return this.req("GET", `/reports/email_reports/${activityId}/tracking/${kind}`);
  }
  /** Aggregate per-activity counts (sends/opens/clicks/bounces/optouts) — one call, no pagination. */
  getCampaignStats(activityId: string) {
    return this.req("GET", `/reports/stats/email_campaign_activities?campaign_activity_ids=${encodeURIComponent(activityId)}`);
  }

  /**
   * High-level: create → set recipients → optional test → schedule. Returns ids.
   * @param guard host-app hook that MUST throw if subject/html contain a lender name
   *        (wire to lib/integrations/blast-safety.ts). Fail closed.
   */
  async createAndSendBlast(o: {
    name: string;
    from_email: string; from_name: string; reply_to_email: string;
    subject: string; html_content: string; preheader?: string;
    contact_list_ids?: string[]; segment_ids?: number[];
    physical_address_in_footer: Record<string, string>;
    scheduledDate?: string;
    testTo?: string[];
    guard?: (fields: { subject: string; html_content: string }) => void | Promise<void>;
  }) {
    if (o.guard) await o.guard({ subject: o.subject, html_content: o.html_content });
    if (!o.contact_list_ids?.length && !o.segment_ids?.length) throw new Error("Blast needs contact_list_ids or segment_ids");

    const camp = (await this.createCampaign(o.name, {
      from_email: o.from_email, from_name: o.from_name, reply_to_email: o.reply_to_email,
      subject: o.subject, html_content: o.html_content, preheader: o.preheader,
    })) as { campaign_id: string; campaign_activities?: Array<{ role?: string; campaign_activity_id: string }> };
    const activity = (camp.campaign_activities || []).find((a) => a.role === "primary_email") || camp.campaign_activities?.[0];
    if (!activity) throw new Error("CC createCampaign returned no primary_email activity");
    const activityId = activity.campaign_activity_id;

    await this.updateActivity(activityId, {
      from_email: o.from_email, from_name: o.from_name, reply_to_email: o.reply_to_email,
      subject: o.subject, html_content: o.html_content, preheader: o.preheader,
      contact_list_ids: o.contact_list_ids, segment_ids: o.segment_ids,
      physical_address_in_footer: o.physical_address_in_footer,
    });

    if (o.testTo?.length) {
      await this.testSend(activityId, o.testTo);
      return { campaign_id: camp.campaign_id, campaign_activity_id: activityId, scheduled: false, tested: true };
    }
    await this.schedule(activityId, o.scheduledDate ?? "0");
    return { campaign_id: camp.campaign_id, campaign_activity_id: activityId, scheduled: true, tested: false };
  }
}
