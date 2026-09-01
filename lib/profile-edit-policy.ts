export const PERSONAL_PROFILE_FIELDS = new Set([
  "full_name",
  "display_name",
  "personal_phone",
  "preferred_language",
  "prospect_focus",
  "custom_fields",
  "onboarding_completed_at",
]);

export const ADMIN_PROFILE_FIELDS = new Set([
  "brand",
  "mrr_target_usd",
  "mrr_current_usd",
  "mrr_target_date",
  "manifesto",
  "primary_agent",
  "agents_enabled",
]);

export type ProfileEditActor = {
  teamRole: string | null | undefined;
  isOwner: boolean;
  adminAccess: boolean;
};

export type ProfileEditDecision =
  | { ok: true; update: Record<string, unknown> }
  | { ok: false; status: 400 | 403; error: string };

export function decideProfileEdit(
  body: Record<string, unknown>,
  actor: ProfileEditActor,
): ProfileEditDecision {
  const role = (actor.teamRole || "").trim().toLowerCase();
  const canManageWorkspace =
    actor.isOwner ||
    role === "owner" ||
    role === "admin" ||
    actor.adminAccess;
  const requestedAdminFields = Object.keys(body).filter((key) => ADMIN_PROFILE_FIELDS.has(key));
  if (requestedAdminFields.length > 0 && !canManageWorkspace) {
    return { ok: false, status: 403, error: "workspace settings require admin access" };
  }

  const update: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (PERSONAL_PROFILE_FIELDS.has(key) || (canManageWorkspace && ADMIN_PROFILE_FIELDS.has(key))) {
      update[key] = body[key];
    }
  }
  if (Object.keys(update).length === 0) {
    return { ok: false, status: 400, error: "no editable fields provided" };
  }
  return { ok: true, update };
}
