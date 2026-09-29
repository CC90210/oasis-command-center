/**
 * /admin — the operator hub behind the rail's shield: every OASIS platform
 * internal in one list.
 *
 * GATE: requireOperator() as the FIRST statement (lib/role-surfaces-session.ts):
 * the session's AUTH USER must be an operator alias AND an active owner/admin
 * of the OASIS workspace. Everyone else gets a 404 — including a signed-out
 * browser and an alias squatter — before anything is read.
 *
 * The rows come from the rail's catalog (OS_NAV_CATALOG, section "admin"), so
 * the hub and the rail cannot list different doors. Each destination keeps its
 * own server gate.
 */

import type { ReactNode } from "react";
import { Activity, Cpu, HeartPulse, History, Inbox, RefreshCcw, ShieldCheck, SquareTerminal } from "lucide-react";
import { requireOperator } from "@/lib/role-surfaces-session";
import { PageFrame } from "@/components/os/PageFrame";
import { LinkList, type LinkListItem } from "@/components/os/landings/LinkList";
import { OS_NAV_CATALOG } from "@/lib/os/nav";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** What each admin door opens onto, keyed by catalog id. */
const ADMIN_DETAIL: Record<string, { description: string; icon: ReactNode }> = {
  "admin-operations": { description: "Background workers, paired machines and the live event tape", icon: <Activity {...ICON} /> },
  "admin-automations": { description: "Cron jobs, background workers and the drafter", icon: <RefreshCcw {...ICON} /> },
  "admin-health": { description: "Buckets that might need you, green when all is fine", icon: <ShieldCheck {...ICON} /> },
  "admin-agent": { description: "The operator power chat, with the CLI bridge", icon: <SquareTerminal {...ICON} /> },
  "admin-fleet": { description: "Every agent, whether it is running, and what it owns", icon: <Cpu {...ICON} /> },
  "admin-runs": { description: "Dashboard actions and their results", icon: <History {...ICON} /> },
  "admin-inbox": { description: "Agent-to-agent handoffs", icon: <Inbox {...ICON} /> },
  "admin-system-health": { description: "Local guard substrate and state-api stats", icon: <HeartPulse {...ICON} /> },
};

export default async function AdminPage() {
  await requireOperator();
  const items: LinkListItem[] = OS_NAV_CATALOG.filter((e) => e.section === "admin").map((e) => ({
    href: e.href,
    label: e.label,
    description: ADMIN_DETAIL[e.id]?.description ?? "",
    icon: ADMIN_DETAIL[e.id]?.icon,
  }));
  return (
    <PageFrame title="Admin" subtitle="OASIS platform internals. Operators only; clients never see this.">
      <LinkList items={items} label="Admin" />
    </PageFrame>
  );
}
