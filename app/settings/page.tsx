/**
 * /settings (top-level) — always renders the signed-in user's home
 * tenant Settings. The body was extracted to components/settings/
 * SettingsContent.tsx on 2026-05-25 so the same surface can also be
 * mounted under /t/<slug>/settings via the manifest catch-all
 * dispatcher (kind="settings"). Single source of truth across both
 * routes — see SettingsContent for the full render logic.
 */

import { SettingsContent } from "@/components/settings/SettingsContent";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  return <SettingsContent />;
}
