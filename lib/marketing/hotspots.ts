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
    kicker: "The seat",
    title: "Someone is always in it",
    body: "Each seat is a role you would otherwise hire for. Maven runs content and demand. Atlas runs the numbers. Bravo runs operations. They start work without being asked and they do not take a week off.",
    points: [
      "A role filled in days, not a hiring round",
      "Works nights, weekends, and while you sleep",
      "Costs a fraction of the salary it stands in for",
      "Add a seat when you need one, not a headcount",
    ],
    anchor: "cockpit",
  },
  {
    id: "engine",
    pin: "02",
    kicker: "The engine",
    title: "You are never stuck on one",
    body: "The AI model is a part, not the product. Swap Claude for GPT, Gemini, Grok or a model on your own hardware and nothing else has to change. When a better one ships in three months, you get the upgrade instead of a rebuild.",
    points: [
      "Best model per job: depth, speed, or cost",
      "Sensitive work stays on your own machines",
      "No rewrite when the frontier moves",
      "Never locked to one vendor's pricing",
    ],
    anchor: "engine",
  },
  {
    id: "chassis",
    pin: "03",
    kicker: "The platform",
    title: "The part that makes it safe to leave running",
    body: "Anyone can demo an agent. The reason this one survives your actual business is underneath: it remembers, it hands work between roles, and it physically cannot do the things you have not allowed.",
    points: [
      "Remembers Monday when you ask on Thursday",
      "One instruction, handled across every role",
      "Money and sends stop for a human by default",
      "Your data, your accounts, never pooled",
    ],
    anchor: "chassis",
  },
  {
    id: "tail",
    pin: "04",
    kicker: "The read-out",
    title: "You see what it did",
    body: "Every action is logged where you can read it in plain English. Nothing runs in a black box, nothing fails quietly, and you are told when something needs you rather than finding out from a customer.",
    points: [
      "A plain-English log of every action taken",
      "Failures alert you, they do not disappear",
      "Hours saved, counted, not estimated",
      "Hand it to your accountant or your lawyer",
    ],
    anchor: "tail",
  },
];
