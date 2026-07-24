import { redirect } from "next/navigation";
import { PageHeader } from "@/components/Card";
import { DripTrackerClient } from "@/components/drips/DripTrackerClient";
import { getSessionUser } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function DripTrackerPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Drip Tracker"
        subtitle="Live outbound loop-sequence telemetry with exact payload inspection."
      />
      <DripTrackerClient />
    </div>
  );
}
