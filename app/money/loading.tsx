/**
 * Money overview skeleton (moved from the Finances overview, which now
 * redirects here). Painted the moment the tab is clicked, in the shape of the
 * real page, while the server render streams in: tabs, headline and month
 * tiles, chart and accounts, recurring costs and the threshold, activity.
 */
import { SkeletonFigures, SkeletonHeader, SkeletonPage, SkeletonPanel, SkeletonTable } from "@/components/founders/finances/Skeleton";

export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <SkeletonFigures count={7} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SkeletonPanel className="h-72 lg:col-span-2" />
        <SkeletonPanel className="h-72" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SkeletonTable rows={4} />
        <SkeletonPanel className="h-40" />
      </div>
      <SkeletonTable rows={8} />
    </SkeletonPage>
  );
}
