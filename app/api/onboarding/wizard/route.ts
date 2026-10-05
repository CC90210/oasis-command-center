/**
 * POST /api/onboarding/wizard
 *
 * Final step of the onboarding wizard, where a workspace OWNER sets up their
 * own workspace. Body:
 *   {
 *     template: "real_estate" | "ecommerce" | "agency" | "custom",
 *     answers:  { brand_name, tagline, departments[], modules[], chat_apps[], jev, ...industry keys }
 *   }
 *
 * WHO MAY CALL IT (2026-09-30, audit finding wizard-member-becomes-owner).
 * The workspace owner (user_profiles.is_owner = 1) or a verified platform
 * operator. Anyone else gets 403 and stays exactly what they were. The old
 * route let ANY member with a workspace save a manifest, and then promoted the
 * first caller in a workspace with no owner to owner: a member could make
 * themselves owner by opening a URL. That promotion is gone; ownership comes
 * only from the operator's owner invite (tenant_invites.kind = 'owner_claim').
 *
 * WHERE IT SAVES. Under the workspace's OWN address (its tenants.slug, or the
 * profile slug it was given), not a slug the caller types: the shell and invite
 * redemption find a workspace's manifest by that address, and wizard manifests
 * saved under a typed slug looked unprovisioned forever.
 *
 * Server-side:
 *   1. Auth-gates the caller: owner of their workspace, or an operator.
 *   2. Folds answers into the chosen template via finalizeManifestFromWizard
 *      (departments -> neutral teammates; chat apps and Jev into integrations).
 *   3. Validates the resulting manifest (parseManifest).
 *   4. Saves the name the owner typed as the workspace's own name
 *      (tenants.name, what the header shows), then saves the manifest through
 *      the audit-logged path the AI editor uses.
 *   5. Marks the owner's onboarding finished and refreshes the session's
 *      onboarding claim, so the gate stops sending them here.
 *
 * Retired: the "business funding" template and its SunBiz drip seeding.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { finalizeManifestFromWizard, type WizardAnswers } from "@/lib/manifest/wizard-finalize";
import { TEMPLATES, TEMPLATE_KEYS, type TemplateKey } from "@/lib/manifest/templates";
import { diffManifests } from "@/lib/manifest/diff";
import { parseManifest } from "@/lib/manifest/schema";
import {
  getManifestRow,
  getManifestSlugForTenant,
  ManifestPersistenceError,
  saveManifest,
} from "@/lib/manifest/persistence";
import { PROTECTED_SLUGS, crossTenantGuard } from "@/lib/manifest/guards";
import { SEED_MANIFESTS } from "@/lib/manifest/seeds";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { wizardAccess } from "@/lib/provisioning/wizard-access";
import { reissueWithOnboardingClaim } from "@/lib/onboarding-claim";
import { getTursoClient } from "@/lib/turso";
import { SESSION_COOKIE, tursoAuthActive, verifySessionAgainstDb } from "@/lib/turso-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  template?: string;
  answers?: WizardAnswers;
};

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const template = (body.template || "").toLowerCase() as TemplateKey;
  if (!TEMPLATE_KEYS.includes(template)) {
    return NextResponse.json({ ok: false, error: "unknown_template" }, { status: 400 });
  }
  const answers = body.answers || {};

  const access = await wizardAccess(user);
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error, reason: access.reason }, { status: access.status });
  }
  const tenantId = access.profile.tenant_id;
  const service = getServiceSupabase();

  // The workspace's own address.
  const tenantRead = await service.from("tenants").select("slug, custom_fields").eq("id", tenantId).maybeSingle();
  if (tenantRead.error || !tenantRead.data) {
    return NextResponse.json(
      { ok: false, error: "workspace_unreadable", reason: "Could not read your workspace. Try again." },
      { status: 503 },
    );
  }
  const tenantRow = tenantRead.data as { slug: string | null; custom_fields: Record<string, unknown> | null };
  const slug = resolveClientProfileSlug({ slug: tenantRow.slug || "", custom_fields: tenantRow.custom_fields || {} }) || "";

  // CREATE only: a workspace already set up is changed from Settings or by
  // OASIS, never re-created here.
  let existingForTenant: string | null;
  let existingForSlug: Awaited<ReturnType<typeof getManifestRow>>;
  try {
    [existingForTenant, existingForSlug] = await Promise.all([getManifestSlugForTenant(tenantId), getManifestRow(slug)]);
  } catch (err) {
    console.error("[onboarding.wizard] manifest lookup failed", err);
    return NextResponse.json(
      { ok: false, error: "manifest_unreadable", reason: "Could not check your workspace setup. Try again." },
      { status: 503 },
    );
  }
  if (existingForTenant || existingForSlug) {
    return NextResponse.json(
      { ok: false, error: "already_set_up", reason: "This workspace is already set up." },
      { status: 409 },
    );
  }
  // Platform seed names and OASIS's/SunBiz's own workspace names are never
  // claimable here (the shared PROTECTED_SLUGS list), then the cross-workspace
  // check: a row-less slug that is another workspace's name is refused, and a
  // failed ownership read refuses with 503.
  const profile = access.profile;
  if (SEED_MANIFESTS[slug] || PROTECTED_SLUGS.has(slug)) {
    return NextResponse.json(
      { ok: false, error: "reserved_slug", reason: "This workspace's address is reserved and cannot be set up here." },
      { status: 409 },
    );
  }
  const claim = await crossTenantGuard(slug, profile.tenant_id);
  if (!claim.ok) {
    return NextResponse.json({ ok: false, error: claim.error, reason: claim.reason }, { status: claim.status });
  }

  let manifest;
  try {
    manifest = parseManifest(finalizeManifestFromWizard({ template, slug, answers }));
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "build_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 422 },
    );
  }

  // The name the owner typed in "Name your workspace" becomes the workspace's
  // own name (tenants.name), which is what the header shows first
  // (lib/provisioning/workspace-name.ts). Without this the manifest carried the
  // new name and the header kept the placeholder, e.g. "Dana's workspace"
  // (2026-09-30 verifier). Written BEFORE the create-only save: if it fails,
  // nothing is saved and the owner can retry the whole step.
  const workspaceName = typeof answers.brand_name === "string" ? answers.brand_name.trim().slice(0, 120) : "";
  if (workspaceName) {
    const renamed = await service
      .from("tenants")
      .update({ name: workspaceName, updated_at: new Date().toISOString() })
      .eq("id", tenantId)
      .select("id");
    if (renamed.error || (renamed.data || []).length !== 1) {
      console.error("[onboarding.wizard] workspace name not saved; nothing saved", {
        tenantId,
        error: renamed.error?.message ?? "no row updated",
      });
      return NextResponse.json(
        {
          ok: false,
          error: "workspace_name_unsaved",
          reason: "Your workspace name could not be saved, so nothing was saved. Try again.",
        },
        { status: 503 },
      );
    }
  }

  let result;
  try {
    result = await saveManifest({
      slug,
      next: manifest,
      diff: diffManifests(TEMPLATES[template], manifest),
      actor: { type: "user", id: user.id },
      message: `Onboarding wizard — template "${template}"`,
      tenant_id: tenantId,
    });
  } catch (err) {
    if (err instanceof ManifestPersistenceError) {
      const status = err.code === "version_conflict" ? 409 : err.code === "validation" ? 422 : 500;
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status });
    }
    throw err;
  }

  // The owner has finished onboarding. An operator running it for a client
  // does not mark their own profile.
  if (!access.operator) {
    const done = await service
      .from("user_profiles")
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq("id", access.profile.id)
      .is("onboarding_completed_at", null);
    if (done.error) {
      console.error("[onboarding.wizard] could not mark onboarding finished", { profileId: access.profile.id, error: done.error.message });
    }
  }

  const res = NextResponse.json({
    ok: true,
    slug,
    manifest: result.row.manifest,
    version: result.row.version,
    audit_id: result.audit_id,
  });
  if (tursoAuthActive()) {
    const session = await verifySessionAgainstDb(getTursoClient(), req.cookies.get(SESSION_COOKIE)?.value);
    if (session) await reissueWithOnboardingClaim(res, getTursoClient(), session);
  }
  return res;
}
