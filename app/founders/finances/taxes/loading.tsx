/**
 * Taxes skeleton. Painted the moment the tab is clicked (Next prefetches
 * it), in the shape of the real page, while the server render streams in.
 */
import { SkeletonHeader, SkeletonPage, SkeletonPanel, SkeletonTable } from "@/components/founders/finances/Skeleton";

export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader action={false} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SkeletonPanel className="h-56" />
        <SkeletonPanel className="h-56 lg:col-span-2" />
      </div>
      <SkeletonTable rows={6} />
    </SkeletonPage>
  );
}
