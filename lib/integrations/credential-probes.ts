export type CredentialProbeResult = { ok: boolean; error?: string; detail?: string };
export type SmtpProbeConfig = { host: string; port: number; secure: boolean; user: string; password: string };
export type CredentialProbeDeps = {
  fetch: typeof fetch;
  verifySmtp: (config: SmtpProbeConfig) => Promise<boolean>;
};

const digits = (value: string | undefined): string => (value || "").replace(/[^0-9]/g, "");

export async function probeMarketingCredential(
  service: string,
  bundle: Record<string, string>,
  deps: CredentialProbeDeps,
): Promise<CredentialProbeResult | null> {
  if (service === "smtp" || service === "gws") {
    const host = service === "gws" ? "smtp.gmail.com" : bundle.host;
    const port = service === "gws" ? 587 : Number(bundle.port || "587");
    const user = service === "gws" ? bundle.from_address : bundle.user;
    const password = service === "gws" ? bundle.app_password : bundle.password;
    if (!host || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "missing_or_invalid_smtp_fields" };
    try {
      const ok = await deps.verifySmtp({ host, port, secure: port === 465, user, password });
      return ok ? { ok: true, detail: "SMTP authentication verified without sending" } : { ok: false, error: "smtp_verify_failed" };
    } catch {
      return { ok: false, error: "smtp_verify_failed" };
    }
  }

  if (service === "late") {
    if (!bundle.api_key) return { ok: false, error: "missing_api_key" };
    try {
      const response = await deps.fetch("https://getlate.dev/api/v1/profiles", { method: "GET", headers: { Authorization: `Bearer ${bundle.api_key}`, Accept: "application/json" } });
      if (response.ok) return { ok: true, detail: "Late account access verified" };
      return { ok: false, error: response.status === 401 || response.status === 403 ? "invalid_credentials" : `late_http_${response.status}` };
    } catch {
      return { ok: false, error: "late_network_error" };
    }
  }

  if (service === "meta_ads") {
    if (!bundle.access_token || !bundle.ad_account_id) return { ok: false, error: "missing_meta_fields" };
    const accountId = bundle.ad_account_id.startsWith("act_") ? bundle.ad_account_id : `act_${bundle.ad_account_id}`;
    const url = new URL(`https://graph.facebook.com/${accountId}`);
    url.searchParams.set("fields", "id,name,account_status");
    try {
      const response = await deps.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${bundle.access_token}`, Accept: "application/json" } });
      if (response.ok) return { ok: true, detail: `Meta ad account ${accountId} verified` };
      return { ok: false, error: response.status <= 403 ? "invalid_credentials_or_account" : `meta_http_${response.status}` };
    } catch {
      return { ok: false, error: "meta_network_error" };
    }
  }

  if (service === "google_ads") {
    const customerId = digits(bundle.customer_id);
    if (!bundle.developer_token || !customerId || !bundle.client_id || !bundle.client_secret || !bundle.refresh_token) return { ok: false, error: "missing_google_ads_fields" };
    try {
      const tokenResponse = await deps.fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: bundle.client_id, client_secret: bundle.client_secret, refresh_token: bundle.refresh_token, grant_type: "refresh_token" }).toString(),
      });
      const tokenJson = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
      if (!tokenResponse.ok || !tokenJson.access_token) return { ok: false, error: "google_oauth_failed" };
      const headers: Record<string, string> = { Authorization: `Bearer ${tokenJson.access_token}`, "developer-token": bundle.developer_token, Accept: "application/json" };
      const managerId = digits(bundle.login_customer_id);
      if (managerId) headers["login-customer-id"] = managerId;
      const accountsResponse = await deps.fetch("https://googleads.googleapis.com/v25/customers:listAccessibleCustomers", { method: "GET", headers });
      const accountsJson = (await accountsResponse.json().catch(() => ({}))) as { resourceNames?: string[] };
      if (!accountsResponse.ok) return { ok: false, error: `google_ads_http_${accountsResponse.status}` };
      if (!(accountsJson.resourceNames || []).includes(`customers/${customerId}`)) return { ok: false, error: "google_customer_not_accessible" };
      return { ok: true, detail: `Google Ads customer ${customerId} verified` };
    } catch {
      return { ok: false, error: "google_ads_network_error" };
    }
  }
  return null;
}
