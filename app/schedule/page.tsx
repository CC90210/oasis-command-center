import type { Metadata } from "next";
import { CalendarApp } from "@/components/calendar/CalendarApp";

export const metadata: Metadata = { title: "Schedule · OASIS AI" };

export default function SchedulePage() {
  return <CalendarApp />;
}
