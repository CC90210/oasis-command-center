/**
 * /settings (top-level) — always renders the signed-in user's home
 * tenant Settings. The body was extracted to components/settings/
 * SettingsContent.tsx on 2026-05-25 so the same surface can also be
 * mounted under /t/<slug>/settings via the manifest catch-all
 * dispatcher (kind="settings"). Single source of truth across both
 * routes — see SettingsContent for the full render logic.
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSystemSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // System surface — tenant branding, integration keys, provider credentials,
  // team management. 404 for an outside contractor.
  //
  // KNOWN CONSEQUENCE, accepted deliberately: this page also hosts the
  // change-password form, so a rep can no longer change their password from
  // inside the app. /forgot-password is public and covers it. If reps end up
  // needing more self-service, the right fix is a small /account page for
  // everyone — not widening this one back open.
  //
  // Gated HERE, not in SettingsContent: the same component is mounted at
  // /t/<slug>/settings for other tenants' operators and must stay untouched.
  await requireSystemSurface();
  return <SettingsContent />;
}
