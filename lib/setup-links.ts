/**
 * lib/setup-links.ts - where every "Set up / Connect / Add a key / Fix" button
 * goes, declared once.
 *
 * CC, 2026-10-09: "when you're on different pages and it tells you to set it
 * up, it's really mapping ... have proper processes in place to fulfill that."
 * A call-to-action that says "Connect" must land on the exact place that
 * connects it: the settings section with its #anchor opened (OpenSectionOnHash),
 * the one connector card (?app=<slug>), never a generic page, a dead link, or a
 * page the viewer's role cannot open.
 *
 * Every CTA in components/ and app/ resolves its target here:
 *
 *   setupHref("ai_account")                  the href, for a surface that has
 *                                            already gated the viewer
 *   setupLink("ai_account", viewer)          the link, or an "Ask your workspace
 *                                            owner to ..." line when the viewer
 *                                            cannot open the target
 *
 * tests/setup-links.test.ts proves every href resolves to a real route file,
 * every #anchor is an id in the file named here, and every connector slug is in
 * the catalog; its scan fails when a component hardcodes a Settings href.
 *
 * PURE: no session, no database, no "server-only". The viewer is passed in.
 * Existing constants are reused, never copied (ENGINE_SETTINGS_HREF,
 * connectorHref).
 */

import { ENGINE_SETTINGS_HREF } from "@/lib/ai/agent-engine";
import { connectorBySlug, connectorHref } from "@/lib/os/connectors";

/** Who can open the target. Matches components/settings/settings-sections.ts audiences. */
export type SetupAudience = "everyone" | "manage" | "operator";

export type SetupViewer = {
  /** Workspace owner / admin (canManageWorkspaceSettings). */
  canManage: boolean;
  /** Verified platform operator (resolvePlatformOperator). */
  isOperator?: boolean;
};

export type SetupNeed =
  | "ai_engine"
  | "ai_account"
  | "bridge_install"
  | "bridge_devices"
  | "business_profile"
  | "revenue_goal"
  | "team"
  | "brand"
  | "profile"
  | "connections"
  | "chat_apps"
  | "workspace_setup"
  | "finance_stripe"
  | "finance_bank_import"
  | "finance_exchange_rates"
  | `connector:${string}`;

type SetupTarget = {
  /** Path, then optional query and fragment, as the browser is sent there. */
  href: string;
  audience: SetupAudience;
  /** The button's words. */
  label: string;
  /** What a viewer who cannot open the target is told instead. */
  ask: string;
  /**
   * Repo-relative file that renders the #anchor's id, when href has one.
   * tests/setup-links.test.ts opens it and looks for the id.
   */
  anchorIn?: string;
};

const SETTINGS_CONTENT = "components/settings/SettingsContent.tsx";

/** Static needs. Connector needs are built by connectorTarget() from the catalog. */
const TARGETS: Record<Exclude<SetupNeed, `connector:${string}`>, SetupTarget> = {
  // Settings > AI brain > "What powers your agents" (id="engine").
  ai_engine: {
    href: ENGINE_SETTINGS_HREF,
    audience: "manage",
    label: "Choose what powers your agents",
    ask: "Ask your workspace owner to choose what powers your agents.",
    anchorIn: SETTINGS_CONTENT,
  },
  // Settings > AI brain > "What powers your agents" > "Your AI account" (id="providers"): where a key is saved.
  ai_account: {
    href: "/settings/ai#providers",
    audience: "manage",
    label: "Connect an AI account",
    ask: "Ask your workspace owner to connect an AI account.",
    anchorIn: SETTINGS_CONTENT,
  },
  // The install wizard. F0 containment (2026-09-29): "Install bridge" is the
  // verified operator's alone; everyone else gets a plain line, never the link
  // (components/settings/BridgeInstallLink.tsx; tests/f0-containment.test.ts).
  bridge_install: {
    href: "/settings/devices/install",
    audience: "operator",
    label: "Pair a computer",
    ask: "Ask OASIS to pair a computer for you.",
  },
  // Settings > Devices (id="devices"): the machines already paired. Operators only.
  bridge_devices: {
    href: "/settings/devices#devices",
    audience: "operator",
    label: "Open Devices",
    ask: "Ask OASIS to pair a computer for you.",
    anchorIn: SETTINGS_CONTENT,
  },
  // Name, contact details, password: the Profile section.
  business_profile: {
    href: "/settings",
    audience: "everyone",
    label: "Open your profile",
    ask: "Update your profile in Settings.",
  },
  // Settings > Team > Revenue goal (id="revenue-goal").
  revenue_goal: {
    href: "/settings/team#revenue-goal",
    audience: "manage",
    label: "Set a revenue goal",
    ask: "Ask your workspace owner to set the revenue goal.",
    anchorIn: SETTINGS_CONTENT,
  },
  // Invites, roles, active status.
  team: {
    href: "/team",
    audience: "manage",
    label: "Open Team",
    ask: "Ask your workspace owner to manage the team.",
  },
  // Settings > Brand & domain: the logo every form and page inherits.
  brand: {
    href: "/settings/brand",
    audience: "manage",
    label: "Set your branding",
    ask: "Ask your workspace owner to set the branding.",
  },
  profile: {
    href: "/settings",
    audience: "everyone",
    label: "Open your profile",
    ask: "Update your profile in Settings.",
  },
  // The Connections hub. Owners and admins see every app; a member sees only
  // their own Google there, so the hub is not a member's fix for a workspace app.
  connections: {
    href: "/settings/connections",
    audience: "manage",
    label: "Open Connections",
    ask: "Ask your workspace owner to connect it.",
  },
  chat_apps: {
    href: "/settings/chat-apps",
    audience: "everyone",
    label: "Open Chat apps",
    ask: "Ask your workspace owner to set up chat apps.",
  },
  // A sign-in with no workspace yet: the onboarding wizard provisions one.
  workspace_setup: {
    href: "/onboarding",
    audience: "everyone",
    label: "Finish setting up your workspace",
    ask: "Finish setting up your workspace.",
  },
  finance_stripe: {
    href: "/founders/finances/settings#stripe",
    audience: "manage",
    label: "Connect Stripe",
    ask: "Ask your workspace owner to connect Stripe.",
    anchorIn: "app/founders/finances/settings/page.tsx",
  },
  finance_bank_import: {
    href: "/founders/finances/transactions#import",
    audience: "manage",
    label: "Import a statement",
    ask: "Ask your workspace owner to import a statement.",
    anchorIn: "app/founders/finances/transactions/page.tsx",
  },
  finance_exchange_rates: {
    href: "/founders/finances/settings#exchange-rates",
    audience: "manage",
    label: "Fetch exchange rates",
    ask: "Ask your workspace owner to fetch exchange rates.",
    anchorIn: "app/founders/finances/settings/page.tsx",
  },
};

/** Needs whose target is fixed in code (everything but connector:<slug>). */
export const STATIC_SETUP_NEEDS = Object.keys(TARGETS) as Array<Exclude<SetupNeed, `connector:${string}`>>;

/**
 * One connector's card. Google is the one app a member connects themselves
 * (their own Gmail and Calendar, shown on their Connections page); every other
 * app is the workspace's, so it is an owner's or admin's to connect. A slug the
 * catalog does not know falls back to the hub, never to a drawer that opens
 * nothing; tests/setup-links.test.ts fails on such a slug in source.
 */
function connectorTarget(slug: string): SetupTarget {
  const def = connectorBySlug(slug);
  if (!def) {
    return { ...TARGETS.connections };
  }
  return {
    href: connectorHref(slug),
    audience: slug === "google-workspace" ? "everyone" : "manage",
    label: `Connect ${def.name}`,
    ask: `Ask your workspace owner to connect ${def.name}.`,
  };
}

function targetFor(need: SetupNeed): SetupTarget {
  if (need.startsWith("connector:")) return connectorTarget(need.slice("connector:".length));
  return TARGETS[need as Exclude<SetupNeed, `connector:${string}`>];
}

/** The target href. For a surface that has already gated its viewer. */
export function setupHref(need: SetupNeed): string {
  return targetFor(need).href;
}

/** The target's audience, for the tests and for surfaces that decide before rendering. */
export function setupAudience(need: SetupNeed): SetupAudience {
  return targetFor(need).audience;
}

/** Repo-relative file that renders this need's #anchor id, or null when it has none. */
export function setupAnchorSource(need: SetupNeed): string | null {
  return targetFor(need).anchorIn ?? null;
}

export function viewerMaySetUp(need: SetupNeed, viewer: SetupViewer): boolean {
  switch (targetFor(need).audience) {
    case "everyone":
      return true;
    case "manage":
      return viewer.canManage;
    case "operator":
      return viewer.isOperator === true;
    default:
      // A new audience word with no rule here is refused, not waved through.
      return false;
  }
}

export type SetupLink =
  | { kind: "link"; href: string; label: string }
  | { kind: "ask"; text: string };

/**
 * The call-to-action for this viewer: a link to the exact place when they can
 * open it, otherwise the sentence naming who can. `label` overrides the default
 * button words when the surrounding copy wants its own ("Add AI key").
 */
export function setupLink(need: SetupNeed, viewer: SetupViewer, label?: string): SetupLink {
  const t = targetFor(need);
  if (!viewerMaySetUp(need, viewer)) return { kind: "ask", text: t.ask };
  return { kind: "link", href: t.href, label: label ?? t.label };
}
