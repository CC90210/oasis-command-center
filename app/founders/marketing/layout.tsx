/**
 * FOUNDERS > Content. ContentTabs (Overview - Library - Train - Performance)
 * is the first thing on every Content page, so the Library is reachable from
 * inside the OS shell; the founders portal banner does not render here
 * (components/founders/FoundersPortalBanner.tsx), as on Finances.
 *
 * Gate: every page under here calls resolveFounder() itself, and so does
 * app/founders/layout.tsx. This one is defence in depth, as in the Growth and
 * Finances layouts: a future layout move must fail closed rather than expose
 * a route. It decides nothing else; clients still get a 404, never a tab bar.
 *
 * The loading.tsx beside this file paints the skeleton under the tabs on a tab
 * click (tests/loading-boundaries.test.ts).
 */

import { notFound } from "next/navigation";
import { resolveFounder } from "@/lib/founders/gate";
import { ContentTabs } from "@/components/founders/ContentTabs";

export default async function ContentLayout({ children }: { children: React.ReactNode }) {
  if (!(await resolveFounder())) notFound();
  return (
    <div className="space-y-5">
      <ContentTabs />
      {children}
    </div>
  );
}
