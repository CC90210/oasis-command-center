/**
 * OASIS's own apps, offered as add-ons on Settings › Billing & add-ons (plan
 * "Add-ons (OASIS's own apps)").
 *
 * Every line below is taken from the app's own README, not written for the
 * card: OASIS WHISPR from APPS/oasis-whispr/README.md, OASIS VISION from
 * APPS/osiris/README.md. When a README changes, change the card with it; a
 * catalog that promises more than the app does is the thing this list exists
 * to avoid.
 *
 * Phase 1 has no entitlement table and no download flow, so a card can only
 * describe the app and route the request to OASIS. It never shows a price, a
 * "Buy" button, a download link or an "Installed" state: none of those has a
 * source yet (entitlements `addon.whispr` / `addon.vision` are Phase 2).
 *
 * The icons in public/connectors/addons/ are each app's own icon, rendered at
 * 128px from the app's repository (Whispr's assets/oasis-whispr.ico, Vision's
 * public/oasis-tree-128.png).
 */

export type AddonDef = {
  slug: "oasis-whispr" | "oasis-vision";
  name: string;
  /** One line under the name. */
  summary: string;
  /** Public path of the app's own icon. */
  icon: string;
  /** Where it runs. */
  platforms: string;
  /** What it does, in the README's own terms. */
  facts: readonly string[];
  /** What leaves the machine, stated plainly. */
  privacy: string;
  /**
   * The app's own install guide, shown only on OASIS's workspace (the one
   * that built it): a client's card routes a request to OASIS instead.
   */
  installGuide: { href: string; label: string };
};

export const OASIS_ADDONS: readonly AddonDef[] = [
  {
    slug: "oasis-whispr",
    name: "OASIS Whispr",
    summary: "Local, private dictation for Mac and Windows",
    icon: "/connectors/addons/oasis-whispr.png",
    platforms: "macOS and Windows",
    facts: [
      "Hold Ctrl and talk, or tap it twice to talk hands-free. The words are typed into whatever window you are already in.",
      "Ctrl is only the default: any key or combination can be the shortcut, Fn on a Mac included, chosen in Settings.",
      "About 1 to 1.5 seconds from letting go to edited text.",
      "Starts at login (a Startup shortcut on Windows, a LaunchAgent on a Mac) and sits in the background.",
    ],
    privacy:
      "The speech model runs on your computer, with no OASIS account, key or server. The one step that leaves the machine is the AI edit that turns speech into written text, which runs through the Claude Code or OpenCode you are already logged into. Switch it off and nothing leaves at all.",
    installGuide: { href: "https://github.com/CC90210/Oasis-Wispr#readme", label: "Install guide" },
  },
  {
    slug: "oasis-vision",
    name: "OASIS Vision",
    summary: "A local-first intelligence console",
    icon: "/connectors/addons/oasis-vision.png",
    platforms: "macOS and Windows",
    facts: [
      "Live aircraft, satellites, maritime traffic, public cameras, earthquakes, wildfires, severe weather and markets on one globe.",
      "Cyber-threat feeds and conflict mapping alongside, with a reconnaissance toolkit attached.",
      "A desktop app with its own window, launched from the Dock or the Start Menu.",
    ],
    privacy:
      "Runs on your machine, with no account, no telemetry and no API key required to start. The data stays on the computer that fetched it.",
    installGuide: { href: "https://github.com/CC90210/oasis-vision#install", label: "Install guide" },
  },
];
