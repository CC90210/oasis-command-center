/**
 * Section loading state: the skeleton app/loading.tsx used to draw around
 * every page. Signed-in sections carry their own so the public site has no
 * boundary above it (tests/loading-boundaries.test.ts says why).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function Loading() {
  return <PageSkeleton variant="page" />;
}
