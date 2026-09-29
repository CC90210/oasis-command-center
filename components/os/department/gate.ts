/**
 * components/os/department/gate.ts — may this viewer open /team/<slug>?
 *
 * PURE, and deliberately thin: it asks the rail. A department tab is visible on
 * the rail exactly when mayOpenOsHref (lib/os/nav.ts) says so, and this gate
 * asks the same predicate with the same inputs, so a tab can never sit over a
 * 404 and a hidden department can never be opened by typing its URL. Finance is
 * the case that matters: module `finance` + an owner + OASIS's company money
 * (fin_* is not tenant-scoped yet), exactly the Money rule.
 *
 * An unknown slug and a known slug the viewer may not open both answer null, so
 * the page 404s identically and the response does not confirm which
 * departments exist.
 */

import { mayOpenOsHref, type BuildOsNavInput } from "@/lib/os/nav";
import { departmentBySlug, type OsDepartment } from "@/lib/os/departments";

export function departmentGate(slug: string | null | undefined, input: BuildOsNavInput): OsDepartment | null {
  const dept = departmentBySlug(slug);
  if (!dept) return null;
  return mayOpenOsHref(input, dept.href) ? dept : null;
}
