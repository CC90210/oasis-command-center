/**
 * lib/os/approvals/scope.ts — who is looking at approvals, derived from the
 * same inputs the rail was drawn from.
 *
 * PURE. The pages and the API routes resolve the session once (the rail's
 * BuildOsNavInput plus the viewer surface) and hand it here. A department the
 * rail would not open for this viewer contributes no approvals, so a Needs-you
 * card can never show a department the viewer cannot otherwise reach.
 */
import type { Persona } from "@/lib/role-surfaces";
import type { DepartmentKey } from "@/lib/os/types";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { mayOpenOsHref, type BuildOsNavInput } from "@/lib/os/nav";
import { approvalScopeFor, type ApprovalScope } from "@/lib/os/approvals/rules";

/** The departments the rail opens for this viewer (mayOpenOsHref over OS_DEPARTMENTS). */
export function openDepartmentsFor(navInput: BuildOsNavInput): Set<DepartmentKey> {
  return new Set(OS_DEPARTMENTS.filter((d) => mayOpenOsHref(navInput, d.href)).map((d) => d.key));
}

export function approvalScopeFromViewer(input: {
  surface: { tenantId: string; userId: string; persona: Persona; capabilities: { canAct: boolean } };
  navInput: BuildOsNavInput;
}): ApprovalScope {
  return approvalScopeFor({
    tenantId: input.surface.tenantId,
    userId: input.surface.userId,
    persona: input.surface.persona,
    canAct: input.surface.capabilities.canAct,
    openDepartments: openDepartmentsFor(input.navInput),
  });
}
