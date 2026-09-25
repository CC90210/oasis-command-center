/**
 * Transactions skeleton. Painted the moment the tab is clicked (Next prefetches
 * it), in the shape of the real page, while the server render streams in.
 */
import { SkeletonHeader, SkeletonPage, SkeletonPanel, SkeletonTable } from "@/components/founders/finances/Skeleton";

export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <SkeletonPanel className="h-24" />
      <SkeletonTable rows={12} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SkeletonPanel className="h-56" />
        <SkeletonPanel className="h-56" />
      </div>
    </SkeletonPage>
  );
}
