/**
 * lib/setup-readiness.ts — server-side helpers for the SetupReadinessCard.
 *
 * Computes per-user + per-tenant readiness in a single round-trip so the
 * card can render in one render pass without N+1 fetches. Used by
 * components/settings/SettingsContent.tsx.
 *
 * The card is per-tenant: SunBiz declares Kixie / TextTorrent / Gmail App
 * Password / an AI provider key as required services in its manifest;
 * OASIS declares its own list. Sharing a hardcoded list would surface
 * Stripe + JotForm on SunBiz (irrelevant to a funding shop) and Kixie
 * + TextTorrent on OASIS (irrelevant to CC's empire), so the card now
 * reads `manifest.required_services` and dispatches per item kind.
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { aiServicesWithKey } from "@/lib/queries";
import { isSharedInboxTenant as checkSharedInbox } from "@/lib/shared-inbox-tenants";
import type { ManifestRequiredService } from "@/lib/manifest/schema";

export type ReadinessItem = {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail" | "info";
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
 * Default required_services list for tenants whose manifest doesn't
 * declare its own. Kept intentionally minimal — just an AI provider
 * (the one universal need). Per-tenant manifests should override.
 */
const DEFAULT_REQUIRED_SERVICES: ManifestRequiredService[] = [
  {
    service: "ai_provider",
    label: "AI provider key (Anthropic / OpenRouter / Gemini / OpenAI)",
    kind: "ai_provider",
    detail:
      "Powers backend automations + Claude-driven workflows. Chat itself uses your local bridge + CLI; this key is for the cron / agent loops.",
  },
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
  // shared-inbox tenants (SunBiz etc).
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

  // ----- PERSONAL section -----
  const personal: ReadinessItem[] = [];
  if (tenantId && userId) {
    if (isSharedInboxTenant) {
      // status="info" — this is a NOTE, not a verified check. Operators
      // shouldn't see a green ✓ and assume something was validated; the
      // shared-identity model means there's nothing to set up.
      personal.push({
        key: "gmail_shared_inbox",
        label: "Shared inbox",
        status: "info",
        detail:
          "This workspace uses a shared outbound identity (e.g. SunBiz's submissions@). You don't need to connect personal Gmail — replies to deals you're assigned to will be CC'd to you automatically.",
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

  // ----- TENANT section, manifest-driven -----
  const manifest = await getTenantManifestForUser(tenantId);
  const requiredServices =
    (manifest?.required_services && manifest.required_services.length > 0)
      ? manifest.required_services
      : DEFAULT_REQUIRED_SERVICES;

  // Pre-compute the credential presence sets in parallel so each
  // required-service item can resolve in O(1) below.
  const credentialServices = requiredServices
    .filter((s) => (s.kind || "tenant_credential") === "tenant_credential")
    .map((s) => s.service);
  const needsAiCheck = requiredServices.some((s) => s.kind === "ai_provider");

  const [credentialRows, aiKeySet] = await Promise.all([
    credentialServices.length > 0
      ? db
          .from("tenant_integration_credentials")
          .select("service,field_key")
          .eq("tenant_id", tenantId)
          .in("service", credentialServices)
          .then((r) => (r.data || []) as { service: string }[])
      : Promise.resolve([] as { service: string }[]),
    needsAiCheck ? aiServicesWithKey(tenantId) : Promise.resolve(new Set<string>()),
  ]);

  const credentialPresent = new Set<string>();
  for (const row of credentialRows) credentialPresent.add(row.service);

  for (const req of requiredServices) {
    const kind = req.kind || "tenant_credential";

    if (kind === "shared_inbox_info") {
      tenant.push({
        key: `tenant.${req.service}`,
        label: req.label,
        status: "info",
        detail: req.detail || "Informational only.",
      });
      continue;
    }

    if (kind === "ai_provider") {
      const haveAny = aiKeySet.size > 0;
      tenant.push({
        key: `tenant.${req.service}`,
        label: req.label,
        status: haveAny ? "ok" : "warn",
        detail: haveAny
          ? `Connected: ${Array.from(aiKeySet).sort().join(", ")}.`
          : req.detail || "No AI provider key on file — backend automations cannot run.",
        cta: haveAny
          ? undefined
          : req.cta || { href: "/settings#agents", label: "Add AI key" },
      });
      continue;
    }

    // kind === "tenant_credential" (default)
    const present = credentialPresent.has(req.service);
    tenant.push({
      key: `tenant.${req.service}`,
      label: req.label,
      status: present ? "ok" : "warn",
      detail: present ? "Key on file." : req.detail || "Not yet wired.",
      cta: present
        ? undefined
        : req.cta || { href: "/settings#integrations", label: "Add key" },
    });
  }

  // ----- Universal infra checks (not manifest-driven) -----

  // Lender catalog (Shop Out can't rank without lenders). Only surfaced
  // for SunBiz-style tenants that actually have a lender entity in their
  // manifest data_model.
  const hasLenderEntity = (manifest?.data_model || []).some(
    (e: { name: string }) => e.name === "lender",
  );
  if (hasLenderEntity) {
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
  }

  // Bridge paired + fresh — universal: every tenant needs a bridge for
  // automations / crons / daily plan to fire.
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

  // Per-employee Gmail status — only meaningful for tenants on the
  // per-user OAuth model. Skipped entirely for shared-inbox tenants
  // since per-user OAuth is a no-op under that model.
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
