/**
 * Offers loading state (R1, 2026-10-12). Without this boundary, opening
 * Offers (or returning to it from the editor) kept the previous page on
 * screen until the whole card grid had rendered on the server - the same
 * "click looked ignored" problem app/clients/loading.tsx fixed for Clients.
 * Paints the page's shape at once: title, then the card grid
 * (components/os/PageSkeleton.tsx, shared with Clients/Settings/the root
 * boundary), so nothing jumps once the real cards land.
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function OffersLoading() {
  return <PageSkeleton variant="page" />;
}
