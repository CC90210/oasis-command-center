import { Suspense } from "react";
import { WebLeadsBrowser } from "@/components/web-leads/WebLeadsBrowser";
import { WebLeadsSkeleton } from "@/components/web-leads/WebLeadsSkeleton";

export const dynamic = "force-dynamic";

export default function WebLeadsPage() {
  return (
    <Suspense fallback={<WebLeadsSkeleton />}>
      <WebLeadsBrowser />
    </Suspense>
  );
}
