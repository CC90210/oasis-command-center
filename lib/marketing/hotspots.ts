/**
 * Spatial callouts on the car.
 *
 * The car is an analogy, and an analogy only earns its place if each part
 * maps to something that actually exists. Every entry below points at a
 * real piece of the platform: an agent that runs, a substrate that ships,
 * a telemetry path that logs. Nothing here describes a roadmap item.
 *
 * `at` is in the same world space as the car geometry, so a hotspot rides
 * the body when it rotates rather than floating at a fixed screen position.
 */

export type Hotspot = {
  id: string;
  /** Short label on the pin itself. */
  pin: string;
  /** Card heading. */
  title: string;
  /** Which part of the platform this is. */
  kicker: string;
  /** Plain-English what-it-does. Two sentences maximum. */
  body: string;
  /** Concrete things it produces or enforces. */
  points: string[];
  /**
   * Anchor in car space. Resolved per body where it needs to be (the
   * engine bay moves), otherwise fixed.
   */
  anchor: "cockpit" | "engine" | "chassis" | "tail";
};

export const HOTSPOTS: Hotspot[] = [
  {
    id: "cockpit",
    pin: "01",
    kicker: "Cockpit",
    title: "Maven — content and demand",
    body: "The seat you actually sit in. Maven watches what competitors publish, what formats are working this week, and turns that into a content plan instead of a spreadsheet nobody opens.",
    points: [
      "Competitor and trend sweeps",
      "Brand voice held across every channel",
      "Scheduling and publishing, not just drafting",
    ],
    anchor: "cockpit",
  },
  {
    id: "engine",
    pin: "02",
    kicker: "Engine core",
    title: "The reasoning model",
    body: "Swappable by design. Claude, GPT, Gemini, Grok, Kimi or a model running on your own hardware — the harness around it does not change when you change engines.",
    points: [
      "Pick per task: depth, speed, or cost",
      "Local option keeps data on your machines",
      "No rewrite when a better model ships",
    ],
    anchor: "engine",
  },
  {
    id: "chassis",
    pin: "03",
    kicker: "Platform",
    title: "The part we actually build",
    body: "Everything that makes an agent survivable in production. Agents talk over a shared event bus, memory ages out instead of rotting, and destructive actions hit a guard before they hit your data.",
    points: [
      "Cross-agent event bus",
      "Memory that ages and stays current",
      "Guards on secrets and destructive commands",
    ],
    anchor: "chassis",
  },
  {
    id: "tail",
    pin: "04",
    kicker: "Telemetry",
    title: "Proof it ran",
    body: "Every send, every job, every failure is logged where you can read it. When something breaks you get told, with the traceback, rather than finding out from a customer.",
    points: [
      "Outbound sends through one audited gateway",
      "Failures alert instead of dying quietly",
      "Fleet health you can actually check",
    ],
    anchor: "tail",
  },
];
