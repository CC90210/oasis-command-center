/**
 * lib/forms/lead-link.ts - the link an alert carries to open a lead in Command
 * Center. One place, so every funnel alert (started, completed, booked, offer
 * page) points the same way and a route rename is one edit.
 *
 * Pure and server-free: safe to import from a message builder under test.
 */
import { SITE_ORIGIN } from "@/lib/marketing/routes";

/** The lead's detail page (app/pipeline/[id]). The id is a UUID; encoded anyway. */
export function pipelineLeadUrl(leadId: string): string {
  return `${SITE_ORIGIN}/pipeline/${encodeURIComponent(leadId)}`;
}
