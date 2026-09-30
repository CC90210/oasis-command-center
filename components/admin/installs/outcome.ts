/**
 * components/admin/installs/outcome.ts - the install console's pure helpers:
 * what the operator is told after a write, and what "Set up again" starts
 * from. No React, no fetch: tests/admin-installs.test.ts calls these directly.
 */

import type { CurrentSetup } from "@/lib/provisioning/installs";

export type Step = { title: string; time: string };
export type Outcome = { ok: boolean; message: string; steps?: Step[]; link?: string | null };

export const AUDIT_NOT_RECORDED = "The action was not recorded in the audit log.";

/**
 * A route response as the operator reads it. The owner-invite routes return
 * `invite.audited: false` when the tenant_audit_log row could not be written:
 * the action still happened, so it is reported as done, and the missing audit
 * record is said out loud rather than hidden (2026-09-30 fix pass).
 */
export function outcomeFrom(json: Record<string, unknown>, fallback: string): Outcome {
  const steps = Array.isArray(json.steps) ? (json.steps as Step[]) : undefined;
  if (json.ok === true) {
    const invite = json.invite as { invite_url?: string | null; audited?: unknown } | undefined;
    const base = typeof json.message === "string" ? json.message : "Done.";
    return {
      ok: true,
      message: invite?.audited === false ? `${base} ${AUDIT_NOT_RECORDED}` : base,
      steps,
      link: invite?.invite_url ?? null,
    };
  }
  return { ok: false, message: typeof json.message === "string" ? json.message : fallback, steps };
}

/**
 * The confirmation before a setup is saved. For a workspace that is already
 * set up it names what the save replaces and what it keeps
 * (lib/provisioning/manifest.ts mergeProvisionedManifest), because the save
 * changes a live workspace its members are using.
 */
export function setupConfirmation(workspaceName: string, alreadySetUp: boolean): string {
  if (!alreadySetUp) return `Set up ${workspaceName} with these choices? Members see the new departments on their next page load.`;
  return (
    `Save these choices to ${workspaceName}? This replaces its departments, add-ons, chat apps, fast classifier ` +
    `setting and department teammates. Its own name, tagline, pages, saved prompts and the teammates it added stay. ` +
    `Members see the change on their next page load.`
  );
}

export type Choices = { departments: string[]; modules: string[]; chatApps: string[]; jev: "off" | "shadow" };

/**
 * Where the set-up form starts. A workspace that is set up starts from its
 * OWN stored choices (the first version always showed the defaults, so saving
 * without looking replaced a workspace's departments with the default four).
 * Only add-ons the console offers are pre-ticked: `finance` is recorded by the
 * Finance department, not chosen as an add-on.
 */
export function initialChoices(
  current: CurrentSetup | "unreadable" | null,
  defaults: readonly string[],
  offeredModules: readonly string[],
): Choices {
  if (!current || current === "unreadable") {
    return { departments: [...defaults], modules: [], chatApps: [], jev: "off" };
  }
  return {
    departments: current.departments ? [...current.departments] : [...defaults],
    modules: current.modules.filter((m) => offeredModules.includes(m)),
    chatApps: [...current.chatApps],
    jev: current.jev,
  };
}
