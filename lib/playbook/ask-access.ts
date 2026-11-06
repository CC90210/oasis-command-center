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

/**
 * The departments the viewer may open, or null when that could not be checked
 * (signed out, a workspace that could not be read, or a read that failed,
 * logged). A page that would otherwise tell the viewer "none of these is open
 * to you" says it could not check instead: an absent answer is not a zero.
 */
export async function readOpenAskDepartments(): Promise<AskDepartmentSlug[] | null> {
  let os: Awaited<ReturnType<typeof resolveOsViewer>>;
  try {
    os = await resolveOsViewer();
  } catch (err) {
    console.error("[playbook.ask-access]", err);
    return null;
  }
  if (!os.ok) return null;
  const { navInput } = os;
  return OS_DEPARTMENTS.filter((d) => departmentGate(d.slug, navInput) !== null).map((d) => d.slug as AskDepartmentSlug);
}

/** readOpenAskDepartments for a page that only builds links: could not check is none. */
export async function openAskDepartments(): Promise<AskDepartmentSlug[]> {
  return (await readOpenAskDepartments()) ?? [];
}
