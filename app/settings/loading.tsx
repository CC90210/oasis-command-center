/**
 * Settings section loading state. The Settings layout (its section nav) stays
 * put between sections; without a boundary below it, Next kept the previous
 * section on screen until the next one had rendered, so a click in the nav
 * looked ignored. This shows the section's shape at once instead.
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function SettingsLoading() {
  return <PageSkeleton variant="section" />;
}
