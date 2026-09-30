/**
 * /founders/finances — redirects to /money (2026-09-30).
 *
 * Money is one section with one front page. The Finances overview and the
 * Money overview showed the same book twice with different tiles; its chart,
 * recurring costs and GST/QST threshold moved to /money, and the Finances
 * tabs (FinanceTabs: Overview is /money) sit on top of both.
 *
 * The finance gate still runs first (defence in depth, like every Finances
 * page): a non-owner gets the same 404 here as on /money, before any redirect.
 */
import { notFound, redirect } from "next/navigation";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";

export const dynamic = "force-dynamic";

export default async function FinancesOverviewRedirect() {
  const viewer = await resolveFinanceViewer();
  if (!viewer) notFound();
  redirect("/money");
}
