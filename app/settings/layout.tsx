/**
 * Settings layout — the section nav on the left, the section's page on the
 * right (docs/os-revamp/01 §(c) "Settings split").
 *
 * The nav lists only the sections this viewer may open
 * (visibleSettingsSections); every section page gates on the same predicate,
 * so a link can never lead to a 404 and a hidden section can never be reached.
 *
 * No gate here. A layout that 404s would take down pages with gates of their
 * own (the audit log redirects rather than 404ing), so a viewer with no
 * Settings access simply gets no nav, and each page decides.
 */

import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { visibleSettingsSections } from "@/components/settings/settings-sections";
import { loadSettingsViewer } from "@/components/settings/settings-viewer";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const viewer = await loadSettingsViewer();
  if (!viewer.ok) return <>{children}</>;
  const sections = visibleSettingsSections(viewer.access);
  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-10">
      <SettingsNav sections={sections} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
