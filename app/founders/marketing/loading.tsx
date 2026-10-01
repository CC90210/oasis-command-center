/**
 * Content hub loading state, below ContentTabs (app/founders/marketing/layout.tsx).
 * The tab bar stays mounted between Overview, Library, Train and Performance;
 * this boundary paints the skeleton under it on a tab click instead of leaving
 * the previous tab on screen until the next one has rendered
 * (tests/loading-boundaries.test.ts).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function ContentLoading() {
  return <PageSkeleton variant="section" />;
}
