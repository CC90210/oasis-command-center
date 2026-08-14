/** Pure navigation and activation contract for the founders Marketing shell. */
export const GROWTH_SECTIONS = [
  { href: "/founders/growth", label: "Overview", status: "shell" },
  { href: "/founders/growth/organic", label: "Organic", status: "inactive" },
  { href: "/founders/growth/paid", label: "Paid Ads", status: "inactive" },
  { href: "/founders/growth/outreach", label: "Outreach", status: "inactive" },
  { href: "/founders/growth/connections", label: "Account Connections", status: "inactive" },
] as const;

export type GrowthSection = (typeof GROWTH_SECTIONS)[number];

export const MARKETING_SHELL_ACTIVE = false as const;

export const MARKETING_CONNECTION_SERVICES = [
  "gws",
  "smtp",
  "twilio",
  "texttorrent",
  "late",
  "meta_ads",
  "google_ads",
] as const;
