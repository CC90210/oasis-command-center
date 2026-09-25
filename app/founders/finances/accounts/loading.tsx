/**
 * Accounts skeleton. Painted the moment the tab is clicked (Next prefetches
 * it), in the shape of the real page, while the server render streams in.
 */
import { SkeletonHeader, SkeletonPage, SkeletonPanel, SkeletonTable } from "@/components/founders/finances/Skeleton";

export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SkeletonTable rows={6} />
        <SkeletonTable rows={4} />
        <SkeletonTable rows={3} />
        <SkeletonTable rows={5} />
      </div>
      <SkeletonPanel className="h-48" />
    </SkeletonPage>
  );
}
