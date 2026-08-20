import { Suspense } from "react";
import { WebLeadsBrowser } from "@/components/web-leads/WebLeadsBrowser";

export const dynamic = "force-dynamic";

export default function WebLeadsPage() {
  return (
    <div>
      <header className="border-b border-slate-200 px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">Leads</h1>
        <p className="text-sm text-slate-500">
          Canadian businesses by province, city and industry. Website status is from a
          public directory and has not been verified — confirm on the call.
        </p>
      </header>
      <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading…</div>}>
        <WebLeadsBrowser />
      </Suspense>
    </div>
  );
}
