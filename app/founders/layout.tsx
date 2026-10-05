/**
 * Chrome for the Founders Portal.
 *
 * WHY THIS LAYOUT EXISTS
 * The command center hosts several portals in one deployment: SunBiz Funding
 * (lending), OASIS AI, and later real estate. They are separate applications
 * that happen to share a shell. Adon, 2026-08-03: "Those are two very separate
 * pieces of software... it's about separation."
 *
 * Everything under /founders is OASIS's OWN tooling, not a tenant of the
 * platform, not something a customer is ever sold. Each section starts with its
 * own tab bar inside the OS shell: Content (ContentTabs) and Finances
 * (FinanceTabs).
 *
 * NO PORTAL BANNER HERE (2026-10-01). This layout used to mount the cyan
 * "OASIS - Founders Portal" banner, whose chips switch between Content and
 * Finances, above EVERY founders page, and hid it on Content and Finances with
 * a pathname check in the browser. CC asked twice for it to go ("I want to get
 * rid of this", the switch to Finances included; Finances is reached from
 * Money). A banner that every section mounts and two sections hide is one
 * missed check away from coming back, so it is mounted by the one section that
 * still shows it, the Growth preview shell (app/founders/growth/layout.tsx), and
 * no Content or Finances page has it in its layout chain at all.
 * tests/content-hub.test.ts proves that over every page under the Content hub.
 *
 * Access is gated per-page via resolveFounder(): a layout cannot notFound()
 * reliably for every child, and a gate that only half-applies is worse than
 * none. Each page calls the gate itself; this one is defence in depth.
 */

import { notFound } from "next/navigation";
import { resolveFounder } from "@/lib/founders/gate";

export default async function FoundersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defence in depth. Every page also calls resolveFounder(); this catches a
  // future page that forgets to, so the failure mode of forgetting is a 404
  // rather than an open door.
  if (!(await resolveFounder())) notFound();

  return <div className="space-y-6">{children}</div>;
}
