/**
 * Client record loading state: the open tab's shape (components/os/
 * PageSkeleton.tsx), under the record's header. Opening a record from the list
 * painted nothing until the record and its tab had rendered on the server, so
 * the click looked ignored (CC, 2026-10-01). Now app/clients/loading.tsx paints
 * at once while the header (app/clients/[id]/layout.tsx) loads, and this one
 * while the tab below it does.
 *
 * Switching tabs inside a record does not show it: a query-only change keeps
 * the page mounted, so the tab bar itself answers the click and shows the wait
 * (components/os/OsTabBar.tsx).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function ClientRecordLoading() {
  return <PageSkeleton variant="section" />;
}
