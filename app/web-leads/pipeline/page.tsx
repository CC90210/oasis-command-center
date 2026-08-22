import { Suspense } from "react";
import { PipelineBoard } from "@/components/web-leads/PipelineBoard";

export const dynamic = "force-dynamic";

export default function WebLeadsPipelinePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading…</div>}>
      <PipelineBoard />
    </Suspense>
  );
}
