/**
 * AI audits loading state: the board, an engagement, its preview, the
 * catalogue and settings all sit under this one boundary, so a click between
 * them shows the skeleton at once (tests/loading-boundaries.test.ts says why).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function Loading() {
  return <PageSkeleton variant="page" />;
}
