/**
 * /system-health — folded into /health (2026-09-30).
 *
 * This page used to fetch its own /api/state-health over HTTP with no session
 * cookie, got the middleware's 401, and told CC his guards were "off" next to
 * a docker command for a file that does not exist. The guard report, the
 * computer's check-ins and the background workers now live on /health, read
 * in-process by lib/admin/system-health.ts. The old address keeps working for
 * the operator; anyone else gets the same 404 as before.
 */

import { redirect } from "next/navigation";
import { requireOperator } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

export default async function SystemHealthPage() {
  await requireOperator();
  redirect("/health");
}
