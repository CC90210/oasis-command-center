/**
 * Today screen loading skeleton. Renders while the dispatcher beside it
 * fetches the viewer's brief (components/os/PageSkeleton.tsx, shared with
 * every signed-in section's boundary).
 *
 * This used to be app/loading.tsx, a boundary around EVERY page. It moved here
 * with the Today page on 2026-10-16 because it also wrapped the public site:
 * React streams a boundary's content hidden and reveals it by script, so each
 * public page painted this empty skeleton first and its text up to 2.5 s later.
 * Each signed-in section now carries its own loading.tsx instead
 * (tests/loading-boundaries.test.ts pins both halves).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function Loading() {
  return <PageSkeleton variant="page" />;
}
