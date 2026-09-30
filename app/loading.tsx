/**
 * Root loading skeleton. Renders during route transitions (Next.js streams
 * this in while the next page's server components fetch). Replaces the
 * blank flash users would otherwise see.
 *
 * Intentionally minimal — looks like the page is "thinking" without
 * mocking any specific data shape (components/os/PageSkeleton.tsx, shared
 * with the Settings and Founders boundaries).
 */
import { PageSkeleton } from "@/components/os/PageSkeleton";

export default function Loading() {
  return <PageSkeleton variant="page" />;
}
