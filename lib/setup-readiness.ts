/**
 * lib/setup-readiness.ts — server-side helpers for the SetupReadinessCard.
 *
 * Computes per-user + per-tenant readiness in a single round-trip so the
 * card can render in one render pass without N+1 fetches. Used by
 * components/settings/SettingsContent.tsx.
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";

export type ReadinessItem = {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Optional href the user should click to fix this. Internal route. */
  cta?: { href: string; label: string };
};

export type ReadinessReport = {
  personal: ReadinessItem[];
  tenant: ReadinessItem[] | null; // null when the viewer isn't owner/admin
};

const PERSONAL_OAUTH_SERVICES = ["gmail_oauth"];

/**
 * Tenant-shared services the owner/admin must wire so day-to-day sends
 * + ingest + billing work. SunBiz-focused defaults; expand as more
 * tenants come online and want their own readiness opinion.
 *
 * Hardcoded for now. Long-term home is manifest.required_services so
 * each tenant declares its own readiness opinion — until then, OASIS
 * and SunBiz share this list (acceptable: both need Anthropic + SMTP;
 * Stripe is universal billing; JotForm matters for SunBiz intake but
 * is harmless to flag missing on OASIS).
 */
import { isSharedInboxTenant as checkSharedInbox } from "@/lib/shared-inbox-tenants";

const TENANT_REQUIRED_SERVICES: { service: string; label: string }[] = [
  { service: "anthropic", label: "Anthropic (Claude API)" },
  { service: "smtp", label: "SMTP relay (outbound email)" },
  { service: "stripe", label: "Stripe (billing)" },
  { service: "jotform", label: "JotForm (intake forms)" },
];

export async function loadReadinessReport(args: {
  tenantId: string | null;
  authUserId: string | null;
  isOwnerOrAdmin: boolean;
}): Promise<ReadinessReport> {
  const db = getServiceSupabase();
  const tenantId = args.tenantId;
  const userId = args.authUserId;

  // Resolve tenant slug so we can branch personal Gmail messaging for
  // shared-inbox tenants (SunBiz etc). One DB call up front — the rest
  // of this function already touches several tables, so the marginal
  // cost is rounding error.
  let tenantSlug: string | null = null;
  if (tenantId) {
    const tenantRes = await db
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .maybeSingle();
    tenantSlug = (tenantRes.data as { slug: string | null } | null)?.slug ?? null;
  }
  const isSharedInboxTenant = checkSharedInbox(tenantSlug);

  const personal: ReadinessItem[] = [];
  if (tenantId && userId) {
    if (isSharedInboxTenant) {
      // Shared-inbox tenants don't surface a personal Gmail item — every
      // send goes via the tenant-shared identity (e.g. SunBiz's shared
      // submissions@). Showing "Connect Gmail" here would tell the
      // operator to do something that has no effect on their outbound.
      personal.push({
        key: "gmail_shared_inbox",
        label: "Shared inbox",
        status: "ok",
        detail:
          "This tenant uses a shared outbound identity. You don't need to connect personal Gmail; replies to deals will be CC'd to you automatically.",
      });
    } else {
      const personalRows = await db
        .from("user_integration_credentials")
        .select("service,field_key")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .in("service", PERSONAL_OAUTH_SERVICES);
      const rows = personalRows.data || [];
      const hasGmail = rows.some(
        (r: { service: string; field_key: string }) =>
          r.service === "gmail_oauth" && r.field_key === "refresh_token",
      );
      personal.push({
        key: "gmail_oauth",
        label: "Personal Gmail",
        status: hasGmail ? "ok" : "warn",
        detail: hasGmail
          ? "Connected. Sends will go through your address."
          : "Not connected — outbound mail will fall back to the shared address.",
        cta: hasGmail
          ? undefined
          : { href: "/settings#integrations", label: "Connect Gmail" },
      });
    }
  }

  if (!args.isOwnerOrAdmin || !tenantId) {
    return { personal, tenant: null };
  }

  const tenant: ReadinessItem[] = [];

  // 1. Required tenant-shared API keys
  const tenantRows = await db
    .from("tenant_integration_credentials")
    .select("service,field_key")
    .eq("tenant_id", tenantId)
    .in(
      "service",
      TENANT_REQUIRED_SERVICES.map((s) => s.service),
    );
  const presentByService = new Set<string>();
  for (const row of (tenantRows.data || []) as { service: string }[]) {
    presentByService.add(row.service);
  }
  for (const req of TENANT_REQUIRED_SERVICES) {
    const present = presentByService.has(req.service);
    tenant.push({
      key: `tenant.${req.service}`,
      label: req.label,
      status: present ? "ok" : "warn",
      detail: present ? "Key on file." : "Not yet wired.",
      cta: present
        ? undefined
        : { href: "/settings#integrations", label: "Add key" },
    });
  }

  // 2. Lender catalog (Shop Out can't rank without lenders)
  const lendersRes = await db
    .from("tenant_records")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lender");
  const lenderCount = lendersRes.count || 0;
  tenant.push({
    key: "tenant.lenders",
    label: "Lender catalog",
    status: lenderCount === 0 ? "fail" : lenderCount < 3 ? "warn" : "ok",
    detail:
      lenderCount === 0
        ? "0 lenders — Shop Out cannot rank without a catalog."
        : lenderCount < 3
          ? `${lenderCount} lender(s) — add 2+ more for meaningful ranking.`
          : `${lenderCount} lenders.`,
    cta:
      lenderCount < 3
        ? { href: "/lenders", label: "Add lenders" }
        : undefined,
  });

  // 3. Bridge paired + fresh
  const bridgeRes = await db
    .from("bridge_pairings")
    .select("id,revoked_at,last_seen_at")
    .eq("tenant_id", tenantId);
  const bridges = (bridgeRes.data || []) as {
    revoked_at: string | null;
    last_seen_at: string | null;
  }[];
  const live = bridges.filter((b) => !b.revoked_at);
  const fresh = live.filter((b) => {
    if (!b.last_seen_at) return false;
    const seen = Date.parse(b.last_seen_at);
    return !Number.isNaN(seen) && Date.now() - seen < 5 * 60 * 1000;
  });
  tenant.push({
    key: "tenant.bridge",
    label: "Bridge / automations runner",
    status: fresh.length > 0 ? "ok" : live.length > 0 ? "warn" : "fail",
    detail:
      fresh.length > 0
        ? `${fresh.length} bridge(s) live with fresh heartbeat.`
        : live.length > 0
          ? `${live.length} paired but no heartbeat in last 5 min.`
          : "No bridge paired — automations (drips, daily plan, renewals) cannot fire.",
    cta:
      live.length === 0
        ? { href: "/settings/devices/install", label: "Install bridge" }
        : undefined,
  });

  // 4. Per-employee Gmail status (owner-visible — surfaces "Alex hasn't
  //    connected" without forcing the owner to chase). Skipped entirely
  //    for shared-inbox tenants since per-user OAuth is a no-op under
  //    that model (every send goes via the shared identity; the
  //    assigned-rep CC layer covers per-deal visibility).
  if (!isSharedInboxTenant) {
    const teamGmailItem = await checkTeamGmail(db, tenantId);
    if (teamGmailItem) tenant.push(teamGmailItem);
  }

  return { personal, tenant };
}

/**
 * Audit per-employee Gmail OAuth connection state for the owner-visible
 * "Team Gmail" readiness item. Returns null when the tenant has no
 * employees to audit. Owners are excluded since they're typically using
 * the shared submissions@ address even on per-user-OAuth tenants.
 */
async function checkTeamGmail(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
): Promise<ReadinessItem | null> {
  const profileRes = await db
    .from("user_profiles")
    .select("email,is_owner,auth_user_id")
    .eq("tenant_id", tenantId);
  const employees = ((profileRes.data || []) as {
    email: string;
    is_owner: boolean;
    auth_user_id: string | null;
  }[]).filter((u) => !u.is_owner && u.auth_user_id);
  if (employees.length === 0) return null;

  const userIds = employees.map((u) => u.auth_user_id as string);
  const credsRes = await db
    .from("user_integration_credentials")
    .select("user_id,service,field_key")
    .eq("tenant_id", tenantId)
    .eq("service", "gmail_oauth")
    .in("user_id", userIds);
  const connected = new Set<string>();
  for (const row of (credsRes.data || []) as {
    user_id: string;
    field_key: string;
  }[]) {
    if (row.field_key === "refresh_token") connected.add(row.user_id);
  }
  const unconnected = employees.filter(
    (u) => !connected.has(u.auth_user_id as string),
  );
  if (unconnected.length === 0) {
    return {
      key: "tenant.team_gmail",
      label: "Team Gmail",
      status: "ok",
      detail: `All ${employees.length} employee(s) have Gmail connected.`,
    };
  }
  return {
    key: "tenant.team_gmail",
    label: "Team Gmail",
    status: "warn",
    detail: `${unconnected.length} of ${employees.length} employee(s) not connected: ${unconnected.map((u) => u.email).join(", ")}`,
    cta: { href: "/team", label: "Open team" },
  };
}
