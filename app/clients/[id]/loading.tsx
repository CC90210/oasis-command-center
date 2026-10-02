/**
 * Client record loading state. Opening a record from the list painted
 * nothing until the record and its tab had rendered on the server, so the
 * click looked ignored (CC, 2026-10-02). It paints the record's shape at once
 * instead: the header and two panels (components/os/PageSkeleton.tsx).
 *
 * Switching tabs inside a record does not show it: a query-only change keeps
 * the page mounted, so the tab bar itself answers the click and shows the wait
 * (components/os/OsTabBar.tsx).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function ClientRecordLoading() {
  return <PageSkeleton variant="section" />;
}
