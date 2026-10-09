/**
 * Clients loading state. Before this boundary, opening the Clients list (or
 * coming back to it from a record) kept the previous page on screen until the
 * whole list had rendered on the server, so the click looked ignored (CC,
 * 2026-10-02). It paints the list's shape at once instead: title, the KPI
 * row, the list (components/os/PageSkeleton.tsx, shared with Settings and the
 * root boundary).
 *
 * The status tabs never wait on it: they filter in the browser
 * (components/os/landings/clients-status.tsx).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function ClientsLoading() {
  return <PageSkeleton variant="page" />;
}
