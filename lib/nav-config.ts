/**
 * Navigation primitives for the command-center shell.
 *
 * THE LIVE RAIL IS NOT BUILT FROM THESE ARRAYS ANY MORE. A workspace's own
 * shell renders OASIS OS sections computed by lib/os/nav.ts (buildOsNav). The
 * arrays below still feed the manifest seeds (lib/manifest/seeds.ts,
 * lib/client-profiles.ts), which is what the /t/<slug> preview and /demo/sun
 * shells render — so they stay until those shells move to the OS model.
 *
 * Keep icons as string keys. These profiles are resolved in a Server
 * Component and then passed to the client Sidebar; passing icon functions
 * across that boundary crashes production rendering. The key → component map
 * is NAV_ICONS in components/os/RailRow.tsx.
 */

export type NavIconKey =
  | "LayoutDashboard"
  | "GitBranch"
  | "Brain"
  | "BookOpen"
  | "Bot"
  | "BarChart3"
  | "Plug"
  | "Settings"
  | "Activity"
  | "Inbox"
  | "History"
  | "ShieldCheck"
  | "ShieldAlert"
  | "Radio"
  | "Users"
  | "BookUser"
  | "FileText"
  | "Upload"
  | "HandCoins"
  | "BadgeDollarSign"
  | "RefreshCcw"
  | "DollarSign"
  | "MessageSquare"
  | "PhoneCall"
  | "Mail"
  | "Landmark"
  | "FileCode2"
  | "UsersRound"
  | "Code2"
  | "Megaphone"
  | "ShoppingBag"
  | "Heart"
  | "Sparkles"
  | "FileSearch"
  | "ClipboardCheck"
  | "Ticket"
  // OASIS OS rail (lib/os/nav.ts). Not accepted in stored manifests:
  // lib/manifest/schema.ts NAV_ICON_KEYS is a deliberate subset.
  | "Home"
  | "Rss"
  | "CalendarDays"
  | "FolderKanban"
  | "Library"
  | "Hash"
  | "GraduationCap"
  | "Building2"
  | "LifeBuoy"
  | "Wallet"
  | "TrendingUp"
  | "Handshake"
  | "Shield"
  | "SquareTerminal"
  | "Cpu"
  | "HeartPulse";

/**
 * NavItem - one entry in the sidebar.
 *
 * `group` is a free-form string label rendered as the uppercase group
 * heading. Items with the same group cluster together while preserving the
 * order in which they first appear in the array.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: NavIconKey;
  group: string;
  badgeKey?: string;
  expandable?: boolean;
};

/**
 * CC's empire command center nav.
 *
 * Routes intentionally hidden from this sidebar:
 *   - /inbox  — cross-agent inbox; useful substrate but no human nav slot
 *   - /runs   — developer-side activity tape; Event Feed serves the same UX
 *   - /system-health — V6 guard-substrate monitor; only meaningful when the
 *     state-api daemon is reachable from this deploy. On the public Vercel
 *     it's always "Off" by design, which CC reads (correctly) as noise.
 *     Reach it by direct URL when the local stack is up.
 * All three routes still resolve by direct URL for agents + scripts; they
 * just don't earn a sidebar slot in CC's day-to-day view.
 */
export const CC_NAV: NavItem[] = [
  // Operations group — daily-use pages CC opens to run the business.
  // /pipeline is the single lead-list surface now (2026-05-21):
  // /leads + /proposals were folded back in because /pipeline renders
  // the same SunBizPipelineView component Sun Biz uses, with the
  // OASIS variant supplying the column set + SLA config. Having two
  // additional sidebar items pointing at the same component was just
  // confusing operators.
  { group: "Operations", href: "/", label: "Today", icon: "LayoutDashboard" },
  { group: "Operations", href: "/schedule", label: "Schedule", icon: "Activity" },
  { group: "Operations", href: "/pipeline", label: "Pipeline", icon: "GitBranch" },
  // Forms — CC's native lead-capture funnel (replaces the retired standalone
  // cc-funnel Vercel app, 2026-06-18). Submissions ingest straight into the
  // pipeline above as `inbound` leads, with a Telegram ping + personalized
  // welcome email. Tenant-scoped: this array feeds ONLY the OASIS manifest, so
  // adding /forms here does NOT leak it onto SunBiz/Suga (they use SUN_NAV /
  // SUGA_NAV). Public form lives at /f/oasis-ai-cc/<slug>.
  { group: "Operations", href: "/forms", label: "Forms", icon: "FileCode2" },
  // Agents -> the full-screen chat (/agent), same as SunBiz, so CC's chat runs
  // full-bleed (isChatShellPath matches /agent). The richer /agents dashboard
  // page — agent states, stats, integration health — stays reachable by URL.
  { group: "Operations", href: "/agent", label: "Agents", icon: "Bot" },
  // /reasoning dropped from CC's nav 2026-08-04 (consolidation audit). It
  // carried two things: a Quick Actions grid that the Prompts Library now
  // does better (every prompt has its own "Open in chat" button, plus search
  // and copy), and the Agent Decisions tape — which moved to /operations,
  // where the rest of the autonomous-loop observability already lives.
  // The ROUTE stays alive and tenant-scoped (the SunBiz seed manifest links
  // /t/sun/reasoning).
  { group: "Operations", href: "/playbook", label: "Playbook", icon: "BookOpen" },
  // System group — observability + control surfaces.
  { group: "System", href: "/operations", label: "Operations", icon: "Activity" },
  { group: "System", href: "/automations", label: "Automations", icon: "RefreshCcw" },
  { group: "System", href: "/health", label: "Health", icon: "ShieldCheck" },
  { group: "System", href: "/analytics", label: "Analytics", icon: "BarChart3" },
  { group: "System", href: "/projects", label: "Projects", icon: "ClipboardCheck" },
  { group: "System", href: "/tickets", label: "Tickets", icon: "FileSearch" },
  { group: "System", href: "/settings", label: "Settings", icon: "Settings" },
  // Nav arc on CC's empire sidebar:
  //   - 13 entries → 7  (Phase 2, 2026-05-16: blunt consolidation, no merge)
  //   - 7 → 10          (Phase 7: restore Reasoning + Health + Overrides
  //                      after CC pointed out Phase 2 was too aggressive)
  //   - 10 → 11         (V6.8.5, 2026-05-17: restore /playbook — V6.8.3
  //                      shipped INTEGRATE_NEW_TOOL at /playbook/prompts
  //                      so the playbook surface is daily-use now, not
  //                      reference. Phase 2's "fold into /settings/playbook"
  //                      plan was never implemented — that path doesn't exist.)
  //
  // Routes reachable by direct URL but intentionally NOT in this sidebar:
  //   /integrations  — app/integrations/page.tsx exists and is functional,
  //                    but it's setup-time work (paste a Stripe key once),
  //                    not daily. Reach via direct URL or deep-link from
  //                    /settings.
  //   /feed          — app/feed/page.tsx exists and
  //                    renders the agent_events stream. /operations shows
  //                    the same stream styled as an Activity Tape; CC reads
  //                    that one, so /feed stays URL-only.
  //   /inbox         — cross-agent inbox, useful substrate, no human nav slot.
  //   /runs          — developer-side activity tape; /operations covers it.
  //   /system-health — V6 guard-substrate monitor; only meaningful when the
  //                    state-api daemon is reachable. On public Vercel it's
  //                    always "Off" by design (noise without the local stack).
  //
  // /forms is now present (above, Operations) — CC's native funnel replaced the
  // standalone cc-funnel app (2026-06-18). /sequences stays absent: it's the
  // SunBiz drip-cadence surface; CC's funnel uses a direct welcome email + the
  // pipeline, not the multi-step sequence engine.
];

/**
 * Sun Biz Funding nav: RETIRED 2026-09-30, kept empty only until its last
 * importer goes.
 *
 * SunBiz was retired on 2026-09-28. This array pointed at /leads (never a
 * route) and at the SunBiz pages retired on 2026-09-30 (/metrics,
 * /applications, /offers, /funded-deals, /renewals, /sms, /email-blast,
 * /lenders, /templates, /embed), and nothing rendered it: the rail is
 * lib/os/nav.ts, and lib/client-profiles.ts's SUN_PROFILE.nav is never read.
 * DELETE this export in the same change that drops the import from
 * lib/client-profiles.ts (a file another track owns). Until then it is empty so
 * no dead link ships, and tests/os-redirects.test.ts checks every href in lib/.
 */
export const SUN_NAV: NavItem[] = [];

/**
 * The web-design leads browser (Adon 2026-08-20). This is NOT a separate
 * client portal — the leads and the operators who work them both live in
 * the OASIS AI command-center tenant (slug `oasis-ai-cc`), the same tenant
 * CC_NAV serves. So this is CC_NAV plus one Leads entry, not a standalone
 * nav: binding that tenant to a WEBDEV_NAV-only profile would strip the 11
 * tabs its operators already use every day. (An earlier version of this
 * feature shipped as a 4-entry standalone nav bound to a zero-user tenant
 * slug `oasis-webdev` — invisible to everyone, see lib/web-leads/data.ts.)
 */
export const WEBDEV_NAV: NavItem[] = [
  ...CC_NAV,
  { group: "Leads", href: "/web-leads", label: "Leads", icon: "Users" },
  { group: "Leads", href: "/commissions", label: "Commissions", icon: "DollarSign" },
  // Training, and the objection library underneath it.
  //
  // A nav row is only half of being reachable: `lib/role-surfaces.ts` narrows
  // this list per persona, so a route absent from SALES_NAV_ALLOWLIST is
  // filtered straight back out for a rep no matter what is written here. Both
  // files were changed together, and the objection surfaces are in this commit
  // because they shipped without either one and no rep could find them.
  { group: "Training", href: "/training", label: "Training", icon: "BookOpen" },
  { group: "Training", href: "/objections", label: "Objections", icon: "MessageSquare" },
  // CC's existing WEBSITE_SALES_STAGES pipeline (lib/website-sales.ts),
  // filtered to this engine's leads -- a VIEW over the fourteen-stage
  // lifecycle CC already runs, never a second one (2026-08-21, Build D).
  // "Web Pipeline", not "Pipeline": CC_NAV (spread above) already carries an
  // Operations → Pipeline entry for /pipeline, so this label collided and the
  // operator saw "Pipeline" twice in one sidebar pointing at two different
  // boards (2026-08-22). Distinct label, same route — bookmarks unaffected.
];

/**
 * Suga nav: RETIRED 2026-09-30, kept empty only until its last importer goes.
 *
 * Eleven of its eighteen rows pointed at top-level routes that were never
 * built (/subscribers, /segments, /posts, /drafts, /queue, /merch, /orders,
 * /affiliates, /sponsorship, /contracts) or at the retired /embed, and nothing
 * rendered it (SUGA_PROFILE.nav in lib/client-profiles.ts is never read; the
 * Suga seed manifest carries its own /t/suga/* nav). DELETE this export in the
 * same change that drops the import from lib/client-profiles.ts.
 */
export const SUGA_NAV: NavItem[] = [];
