/**
 * lib/playbook/ask-access.ts - which departments the signed-in viewer may open,
 * for the Playbook pages that hand a prompt to one ("Ask Marketing").
 *
 * WHY. Every OASIS member reads the Playbook (lib/playbook-access.ts), but the
 * department tabs follow the rail: a sales rep cannot open Marketing or
 * Finance, and /team/<dept> answers them "Page not found" (departmentGate).
 * The drills, the prompts library and the client-deploy runbook built their
 * ask links without asking, so a rep's "Ask Finance" was a 404 (audit, S2 T2
 * fix pass). The business document page already asked; these pages now ask the
 * same gate once per render and pass the answer down.
 *
 * A viewer the rail cannot resolve (signed out, or a workspace that could not
 * be read) may open none: no ask link is better than a link to a 404.
 */

import "server-only";
import { resolveOsViewer } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { AskDepartmentSlug } from "@/lib/os/chat-href";

export async function openAskDepartments(): Promise<AskDepartmentSlug[]> {
  const os = await resolveOsViewer();
  if (!os.ok) return [];
  return OS_DEPARTMENTS.filter((d) => departmentGate(d.slug, os.navInput) !== null).map((d) => d.slug as AskDepartmentSlug);
}
