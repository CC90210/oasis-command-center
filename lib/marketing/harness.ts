/**
 * The car analogy, as data.
 *
 * CC has explained OASIS this way in every sales conversation, and it is
 * the clearest thing we say: the BODY is the agent, the ENGINE is the
 * model, and the CHASSIS — the harness — is what we actually build. The
 * point of the metaphor is that the first two are swappable BECAUSE the
 * third exists. Someone who buys a "GPT chatbot" has bought an engine
 * bolted to the road.
 *
 * Body silhouettes are hand-authored SVG paths on a shared 420x140
 * viewBox, drawn so the wheelbase lines up across all four — swapping a
 * body should morph the shell, not move the car.
 */

export type Body = {
  id: string;
  /** Agent callsign, or "Custom" for the built-to-order slot. */
  name: string;
  seat: string;
  /** What this body is shaped for, in one line. */
  brief: string;
  /** Side-profile shell. Front is at the right. */
  path: string;
  /** Dashed outline for the not-yet-built slot. */
  blueprint?: boolean;
};

export const BODIES: Body[] = [
  {
    id: "bravo",
    name: "BRAVO",
    seat: "Operations · Engineering",
    brief:
      "Long wheelbase, high roof, built to carry load. Plans the work, writes the code, ships it, and reports what changed.",
    path: "M 44 116 L 44 70 C 44 62 50 56 58 56 L 96 56 L 120 30 C 124 26 129 24 134 24 L 262 24 C 268 24 273 26 277 31 L 300 58 L 372 66 C 380 67 386 74 386 82 L 386 116 Z",
  },
  {
    id: "atlas",
    name: "ATLAS",
    seat: "Finance · Reporting",
    brief:
      "Low, heavy, armoured. Reconciles the money and answers 'can we afford this' with the actual figure.",
    path: "M 40 116 L 40 84 C 40 76 46 70 54 69 L 104 64 L 140 38 C 144 34 149 32 155 32 L 252 32 C 258 32 263 34 267 39 L 300 68 L 378 76 C 386 77 392 84 392 92 L 392 116 Z",
  },
  {
    id: "maven",
    name: "MAVEN",
    seat: "Content · Brand · Demand",
    brief:
      "Light, fast, aerodynamic. Writes in your voice and gets it in front of the people who should see it.",
    path: "M 42 116 L 42 88 C 42 80 48 74 56 73 L 108 68 L 156 36 C 160 33 165 31 170 31 L 232 31 C 240 31 246 34 250 41 L 296 74 L 380 82 C 388 83 394 90 394 98 L 394 116 Z",
  },
  {
    id: "custom",
    name: "CUSTOM",
    seat: "Your industry · Your process",
    brief:
      "A shape that doesn't exist yet. Most of what we build is a seat nobody sells, because the job is specific to one business.",
    path: "M 44 116 L 44 78 C 44 70 50 64 58 63 L 104 60 L 140 34 C 144 30 149 28 155 28 L 250 28 C 256 28 261 30 265 35 L 298 62 L 376 70 C 384 71 390 78 390 86 L 390 116 Z",
    blueprint: true,
  },
];

export type Engine = {
  id: string;
  name: string;
  vendor: string;
  /** What you'd pick it for. Honest, not a benchmark table. */
  trait: string;
  /** Hex for the engine glow. Kept off the brand cyan so the engine reads
   *  as a separate, swappable part rather than as more chrome. */
  glow: string;
};

export const ENGINES: Engine[] = [
  {
    id: "claude",
    name: "Claude",
    vendor: "Anthropic",
    trait: "Long context and careful reasoning. What we run most seats on.",
    glow: "#d97757",
  },
  {
    id: "gpt",
    name: "GPT",
    vendor: "OpenAI",
    trait: "Strong at backend implementation and adversarial code review.",
    glow: "#10a37f",
  },
  {
    id: "gemini",
    name: "Gemini",
    vendor: "Google",
    trait: "Fast and cheap at scale. Good for high-volume classification.",
    glow: "#4285f4",
  },
  {
    id: "local",
    name: "Local",
    vendor: "On your hardware",
    trait: "Nothing leaves the building. For work that legally cannot.",
    glow: "#9ca0a8",
  },
];

/** The fixed parts. This is the actual product, and the reason the two
 *  selectors above are selectors at all. */
export const CHASSIS = [
  "Memory that survives the session",
  "Guardrails the model cannot argue past",
  "Your data, your infrastructure, per-tenant isolation",
  "Approval gates on money and outbound",
  "The event bus that lets seats hand work to each other",
];
