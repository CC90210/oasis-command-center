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
      // CC terminal activity statuses are: completed, cancelled, failed (+ processing = in-flight).
      if (["COMPLETED", "COMPLETE", "DONE", "FAILED", "ERROR", "CANCELLED"].includes(String(a.state || a.status).toUpperCase())) return a;
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
  /** Aggregate per-activity counts (sends/opens/clicks/bounces/optouts) — one call, no pagination.
   *  The ids are a PATH segment per the CC spec, NOT a query param. */
  getCampaignStats(activityId: string) {
    return this.req("GET", `/reports/stats/email_campaign_activities/${encodeURIComponent(activityId)}`);
  }

  // ── Campaign management (list / detail / rename / delete / preview / history) ─
  /** List campaigns. `after` is the pagination cursor from a prior `_links.next.href`. */
  listCampaigns(o: { limit?: number; after?: string } = {}) {
    const q = new URLSearchParams({ limit: String(o.limit ?? 50) });
    if (o.after) q.set("after", o.after);
    return this.req("GET", `/emails?${q}`);
  }
  getCampaign(campaignId: string) { return this.req("GET", `/emails/${encodeURIComponent(campaignId)}`); }
  /** Rename a campaign (PATCH is name-only per CC). */
  renameCampaign(campaignId: string, name: string) { return this.req("PATCH", `/emails/${encodeURIComponent(campaignId)}`, { name }); }
  deleteCampaign(campaignId: string) { return this.req("DELETE", `/emails/${encodeURIComponent(campaignId)}`); }
  /** Full activity incl. html_content / footer / permalink when `include` is set. */
  getActivity(activityId: string, include?: string) {
    const q = include ? `?include=${encodeURIComponent(include)}` : "";
    return this.req("GET", `/emails/activities/${encodeURIComponent(activityId)}${q}`);
  }
  getPreview(activityId: string) { return this.req("GET", `/emails/activities/${encodeURIComponent(activityId)}/previews`); }
  getSendHistory(activityId: string) { return this.req("GET", `/emails/activities/${encodeURIComponent(activityId)}/send_history`); }

  // ── Schedule (view / cancel) — POST create lives in schedule() above ─────────
  getSchedule(activityId: string) { return this.req("GET", `/emails/activities/${encodeURIComponent(activityId)}/schedules`); }
  /** Unschedule a queued send (cancel). */
  deleteSchedule(activityId: string) { return this.req("DELETE", `/emails/activities/${encodeURIComponent(activityId)}/schedules`); }

  // ── Reporting (rollup + per-link) — tracking()/getCampaignStats() above ──────
  getSummaryReports(limit = 50) { return this.req("GET", `/reports/summary_reports/email_campaign_summaries?limit=${limit}`); }
  getLinksReport(activityId: string) { return this.req("GET", `/reports/email_reports/${encodeURIComponent(activityId)}/links`); }
  getContactActivity(contactId: string) { return this.req("GET", `/reports/contact_reports/${encodeURIComponent(contactId)}/activity_details`); }
  getContactOpenClickRates(contactId: string) { return this.req("GET", `/reports/contact_reports/${encodeURIComponent(contactId)}/open_and_click_rates`); }
  getContactActivitySummary(contactId: string) { return this.req("GET", `/reports/contact_reports/${encodeURIComponent(contactId)}/activity_summary`); }

  // ── Contacts (CRUD + resubscribe + counts + export) ──────────────────────────
  /** List/search contacts. `include` pulls custom_fields,list_memberships,taggings,notes,phone_numbers,street_addresses. */
  listContacts(o: { limit?: number; cursor?: string; email?: string; lists?: string; segment_id?: string | number; status?: string; tags?: string; include?: string } = {}) {
    const q = new URLSearchParams({ limit: String(o.limit ?? 50) });
    if (o.cursor) q.set("cursor", o.cursor);
    if (o.email) q.set("email", o.email);
    if (o.lists) q.set("lists", o.lists);
    if (o.segment_id != null) q.set("segment_id", String(o.segment_id));
    if (o.status) q.set("status", o.status);
    if (o.tags) q.set("tags", o.tags);
    if (o.include) q.set("include", o.include);
    return this.req("GET", `/contacts?${q}`);
  }
  getContact(contactId: string, include = "custom_fields,list_memberships,taggings,notes,phone_numbers,street_addresses") {
    return this.req("GET", `/contacts/${encodeURIComponent(contactId)}?include=${encodeURIComponent(include)}`);
  }
  createContact(body: Record<string, unknown>) { return this.req("POST", "/contacts", body); }
  updateContact(contactId: string, body: Record<string, unknown>) { return this.req("PUT", `/contacts/${encodeURIComponent(contactId)}`, body); }
  deleteContact(contactId: string) { return this.req("DELETE", `/contacts/${encodeURIComponent(contactId)}`); }
  resubscribeContact(contactId: string) { return this.req("PUT", `/contacts/resubscribe/${encodeURIComponent(contactId)}`); }
  getContactCounts() { return this.req("GET", "/contacts/counts"); }
  startContactExport(body: Record<string, unknown>) { return this.req("POST", "/activities/contact_exports", body); }
  getContactExport(fileExportId: string) { return this.req("GET", `/contact_exports/${encodeURIComponent(fileExportId)}`); }

  // ── Custom fields (typed, ≤25/contact) ──────────────────────────────────────
  getCustomFields() { return this.req("GET", "/contact_custom_fields?limit=100"); }
  createCustomField(body: Record<string, unknown>) { return this.req("POST", "/contact_custom_fields", body); }
  updateCustomField(id: string, body: Record<string, unknown>) { return this.req("PUT", `/contact_custom_fields/${encodeURIComponent(id)}`, body); }
  deleteCustomField(id: string) { return this.req("DELETE", `/contact_custom_fields/${encodeURIComponent(id)}`); }

  // ── Lists (detail / update / delete / membership) — GET all + create above ───
  getList(listId: string) { return this.req("GET", `/contact_lists/${encodeURIComponent(listId)}`); }
  updateList(listId: string, body: Record<string, unknown>) { return this.req("PUT", `/contact_lists/${encodeURIComponent(listId)}`, body); }
  deleteList(listId: string) { return this.req("DELETE", `/contact_lists/${encodeURIComponent(listId)}`); }
  addListMemberships(contactIds: string[], listIds: string[]) {
    return this.req("POST", "/activities/add_list_memberships", { source: { contact_ids: contactIds }, list_ids: listIds });
  }
  removeListMemberships(contactIds: string[], listIds: string[]) {
    return this.req("POST", "/activities/remove_list_memberships", { source: { contact_ids: contactIds }, list_ids: listIds });
  }

  // ── Tags ─────────────────────────────────────────────────────────────────────
  getTags() { return this.req("GET", "/contact_tags?limit=100"); }
  createTag(name: string) { return this.req("POST", "/contact_tags", { name }); }
  updateTag(id: string, name: string) { return this.req("PUT", `/contact_tags/${encodeURIComponent(id)}`, { name }); }
  deleteTag(id: string) { return this.req("DELETE", `/contact_tags/${encodeURIComponent(id)}`); }
  addTags(tagId: string, contactIds: string[]) { return this.req("POST", "/activities/contacts_taggings_add", { tag_id: tagId, source: { contact_ids: contactIds } }); }
  removeTags(tagId: string, contactIds: string[]) { return this.req("POST", "/activities/contacts_taggings_remove", { tag_id: tagId, source: { contact_ids: contactIds } }); }

  // ── Segments (criteria is a JSON string per CC) ──────────────────────────────
  getSegments() { return this.req("GET", "/segments?limit=1000"); }
  getSegment(id: string) { return this.req("GET", `/segments/${encodeURIComponent(id)}`); }
  createSegment(name: string, segmentCriteria: string) { return this.req("POST", "/segments", { name, segment_criteria: segmentCriteria }); }
  updateSegment(id: string, name: string, segmentCriteria: string) { return this.req("PUT", `/segments/${encodeURIComponent(id)}`, { name, segment_criteria: segmentCriteria }); }
  deleteSegment(id: string) { return this.req("DELETE", `/segments/${encodeURIComponent(id)}`); }
  renameSegment(id: string, name: string) { return this.req("PATCH", `/segments/${encodeURIComponent(id)}/name`, { name }); }

  // ── Power: A/B subject test + resend-to-non-openers (SEND paths — guard upstream) ─
  getAbTest(activityId: string) { return this.req("GET", `/emails/activities/${encodeURIComponent(activityId)}/abtest`); }
  createAbTest(activityId: string, body: Record<string, unknown>) { return this.req("POST", `/emails/activities/${encodeURIComponent(activityId)}/abtest`, body); }
  deleteAbTest(activityId: string) { return this.req("DELETE", `/emails/activities/${encodeURIComponent(activityId)}/abtest`); }
  getNonOpenerResend(activityId: string) { return this.req("GET", `/emails/activities/${encodeURIComponent(activityId)}/non_opener_resends`); }
  createNonOpenerResend(activityId: string, body: Record<string, unknown>) { return this.req("POST", `/emails/activities/${encodeURIComponent(activityId)}/non_opener_resends`, body); }
  deleteNonOpenerResend(activityId: string, resendRequestId: string) { return this.req("DELETE", `/emails/activities/${encodeURIComponent(activityId)}/non_opener_resends/${encodeURIComponent(resendRequestId)}`); }

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
    abTest?: { alternative_subject: string; test_size: number; winner_wait_duration: number };
    guard?: (fields: { subject: string; html_content: string }) => void | Promise<void>;
  }) {
    if (o.guard) await o.guard({ subject: o.subject, html_content: o.html_content });
    if (!o.contact_list_ids?.length && !o.segment_ids?.length) throw new Error("Blast needs contact_list_ids or segment_ids");
    // format_type 5 (custom code) emails MUST include [[trackingImage]] in the body per CC, or the
    // campaign activity is rejected. Inject it once if the caller's HTML doesn't already have it.
    const html_content = o.html_content.includes("[[trackingImage]]") ? o.html_content : `${o.html_content}\n[[trackingImage]]`;

    const camp = (await this.createCampaign(o.name, {
      from_email: o.from_email, from_name: o.from_name, reply_to_email: o.reply_to_email,
      subject: o.subject, html_content, preheader: o.preheader,
    })) as { campaign_id: string; campaign_activities?: Array<{ role?: string; campaign_activity_id: string }> };
    const activity = (camp.campaign_activities || []).find((a) => a.role === "primary_email") || camp.campaign_activities?.[0];
    if (!activity) throw new Error("CC createCampaign returned no primary_email activity");
    const activityId = activity.campaign_activity_id;

    await this.updateActivity(activityId, {
      from_email: o.from_email, from_name: o.from_name, reply_to_email: o.reply_to_email,
      subject: o.subject, html_content, preheader: o.preheader,
      contact_list_ids: o.contact_list_ids, segment_ids: o.segment_ids,
      physical_address_in_footer: o.physical_address_in_footer,
    });

    if (o.testTo?.length) {
      await this.testSend(activityId, o.testTo);
      return { campaign_id: camp.campaign_id, campaign_activity_id: activityId, scheduled: false, tested: true };
    }
    // A/B subject test must be applied to the DRAFT activity BEFORE scheduling.
    if (o.abTest) await this.createAbTest(activityId, o.abTest);
    await this.schedule(activityId, o.scheduledDate ?? "0");
    return { campaign_id: camp.campaign_id, campaign_activity_id: activityId, scheduled: true, tested: false };
  }
}
