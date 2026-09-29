/**
 * Loading state below this section's own layout: between its pages the layout
 * stays put, so without a boundary here a click kept the previous page on
 * screen until the next one rendered (tests/loading-boundaries.test.ts). Each
 * Finances page's own skeleton, where it has one, takes precedence.
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function SectionLoading() {
  return <PageSkeleton variant="section" />;
}
