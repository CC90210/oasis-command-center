/**
 * Invoices (list and invoice detail) skeleton. Painted the moment the tab is clicked (Next prefetches
 * it), in the shape of the real page, while the server render streams in.
 */
import { SkeletonHeader, SkeletonPage, SkeletonPanel, SkeletonTable } from "@/components/founders/finances/Skeleton";

export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <SkeletonTable rows={8} />
      <SkeletonPanel className="h-72" />
    </SkeletonPage>
  );
}
