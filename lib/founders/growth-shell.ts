/** Pure navigation and activation contract for the founders Marketing shell. */
export const GROWTH_SECTIONS = [
  { href: "/founders/growth", label: "Overview", status: "shell" },
  { href: "/founders/growth/organic", label: "Organic", status: "inactive" },
  { href: "/founders/growth/paid", label: "Paid Ads", status: "inactive" },
  { href: "/founders/growth/outreach", label: "Outreach", status: "inactive" },
  { href: "/founders/growth/connections", label: "Account Connections", status: "inactive" },
] as const;

export type GrowthSection = (typeof GROWTH_SECTIONS)[number];

/**
 * Re-export, not a second declaration.
 *
 * This constant was declared here by PR #175 and nothing read it, so the shell
 * called itself inactive while the nav happily linked to it — the contradiction
 * behind CC's "there are now two tabs". It now lives in lib/portals/registry.ts
 * because that is where the nav is built, and shared code may not import a
 * portal (isImportAllowed), only the other way round.
 *
 * Kept exported from here so founders-side imports and tests/marketing-shell.test.ts
 * are unchanged. Do NOT re-declare it locally: two copies is how the flag stopped
 * meaning anything the first time.
 */
export { MARKETING_SHELL_ACTIVE } from "@/lib/portals/registry";
