/**
 * lib/slack/status.ts - where each department lives in Slack, for the AI Team
 * roster and the department tab (no longer a hard-coded "Phase 2").
 *
 *   not_configured  OASIS's Slack app is not set up on this deployment
 *   not_connected   this workspace has not installed it
 *   mention_only    installed, no channel mapped to this department: it still
 *                   answers an @mention that names it
 *   channels        the channels mapped to this department
 *   unknown         a read failed, or Slack is installed but its tables are
 *                   not (then nothing answers): never shown as "not
 *                   connected" or "by @mention"
 *
 * Tenant from the caller's session.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { findActiveConnection } from "@/lib/connections/store";
import { providerAvailability, providerById } from "@/lib/connections/registry";
import type { DepartmentKey } from "@/lib/os/types";
import { listChannelRoutes, isSlackSchemaMissing } from "@/lib/slack/routing";

export type SlackHome =
  | { kind: "not_configured" }
  | { kind: "not_connected" }
  | { kind: "mention_only" }
  | { kind: "channels"; names: string[] }
  | { kind: "unknown" };

export type SlackPresence =
  | { kind: "not_configured" | "not_connected" | "unknown" }
  | { kind: "connected"; byDepartment: ReadonlyMap<DepartmentKey, string[]> };

export async function loadSlackPresence(
  db: Client | null,
  tenantId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SlackPresence> {
  const slack = providerById("slack");
  if (!slack || providerAvailability(slack, env) !== "live") return { kind: "not_configured" };
  if (!db) return { kind: "unknown" };
  try {
    const conn = await findActiveConnection(db, tenantId, "slack");
    if (!conn) return { kind: "not_connected" };
    const byDepartment = new Map<DepartmentKey, string[]>();
    try {
      for (const r of await listChannelRoutes(db, tenantId)) {
        if (!r.department) continue;
        const list = byDepartment.get(r.department) ?? [];
        list.push(r.channel_name ?? r.channel_id);
        byDepartment.set(r.department, list);
      }
    } catch (err) {
      if (!isSlackSchemaMissing(err)) throw err;
      // Installed, but the Slack tables are not (bravo__197): the events route
      // refuses every event, so no department answers an @mention. Never
      // "connected" / "by @mention".
      console.error("[slack.status] Slack is installed but migration bravo__197 is not applied", { tenantId });
      return { kind: "unknown" };
    }
    return { kind: "connected", byDepartment };
  } catch (err) {
    console.error("[slack.status]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { kind: "unknown" };
  }
}

/** One teammate's Slack home, across the departments it leads. */
export function slackHomeFor(presence: SlackPresence, departments: readonly DepartmentKey[]): SlackHome {
  if (presence.kind !== "connected") return { kind: presence.kind };
  const names = departments.flatMap((d) => presence.byDepartment.get(d) ?? []);
  return names.length > 0 ? { kind: "channels", names: [...new Set(names)] } : { kind: "mention_only" };
}
