import type { Metadata } from "next";
import { ScheduleClient } from "@/components/schedule/ScheduleClient";

export const metadata: Metadata = { title: "Schedule · OASIS AI" };

export default function SchedulePage() {
  return <ScheduleClient />;
}
