/**
 * Finances Settings skeleton. Painted the moment the tab is clicked (Next prefetches
 * it), in the shape of the real page, while the server render streams in.
 */
import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/founders/finances/Skeleton";

export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <SkeletonPanel className="h-80" />
      <SkeletonPanel className="h-32" />
      <SkeletonPanel className="h-20" />
      <SkeletonPanel className="h-64" />
    </SkeletonPage>
  );
}
