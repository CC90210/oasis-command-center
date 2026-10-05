/**
 * Founders portal loading state. The portal layout stays put between its tabs
 * (Content, Growth, Finances); without a boundary below it, a tab click kept
 * the previous tab on screen until the next one rendered. Finances has its own
 * per-page skeletons, which take precedence below this one.
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function FoundersLoading() {
  return <PageSkeleton variant="section" />;
}
