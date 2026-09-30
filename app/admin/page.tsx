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
 * own server gate. Each description says, in plain words, what the page is for.
 */

import type { ReactNode } from "react";
import { Activity, Cpu, History, Inbox, RefreshCcw, ShieldCheck, SquareTerminal } from "lucide-react";
import { requireOperator } from "@/lib/role-surfaces-session";
import { PageFrame } from "@/components/os/PageFrame";
import { LinkList, type LinkListItem } from "@/components/os/landings/LinkList";
import { OS_NAV_CATALOG } from "@/lib/os/nav";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** What each admin door opens onto, keyed by catalog id. */
const ADMIN_DETAIL: Record<string, { description: string; icon: ReactNode }> = {
  "admin-operations": { description: "What is running right now: your computers, background agents and the live event tape", icon: <Activity {...ICON} /> },
  "admin-automations": { description: "Every schedule and background process, with on/off switches", icon: <RefreshCcw {...ICON} /> },
  "admin-health": { description: "Whether your computer, its safety guards and your automations are working, in plain words", icon: <ShieldCheck {...ICON} /> },
  "admin-agent": { description: "Run Claude Code/Codex in a department's repo on your PC through the bridge (operator only)", icon: <SquareTerminal {...ICON} /> },
  "admin-fleet": { description: "Each agent, whether its processes are running, and what it owns", icon: <Cpu {...ICON} /> },
  "admin-runs": { description: "Every change an agent made to your dashboard data, and whether it worked", icon: <History {...ICON} /> },
  "admin-inbox": { description: "Notes the agents leave each other, and a box to leave one yourself", icon: <Inbox {...ICON} /> },
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
