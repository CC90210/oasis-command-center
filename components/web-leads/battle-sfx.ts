"use client";

/**
 * battle-sfx.ts — the HUD's sound, synthesized from nothing.
 *
 * ═══ WHY SYNTHESIS AND NOT FILES (Adon, 2026-09-01, round 8) ════════════════
 *
 * "Maximize it without having any expenses... we never need to spend money."
 *
 * Every sound here is procedurally generated at play time from OscillatorNode
 * + a gain envelope -- the pattern the Web Audio community has settled on for
 * UI palettes (zero assets, zero bytes downloaded, zero licensing surface,
 * identical on every platform, totally parametric). There is no sound file
 * in this repo and there must never be one: a file is a cost, a licence to
 * clear, and a fetch; an oscillator is none of those.
 *
 * ═══ THE RULES ══════════════════════════════════════════════════════════════
 *
 * 1. OFF BY DEFAULT, per rep. A rep is ON THE PHONE next to this card; a HUD
 *    that beeps into a live sales call is sabotage dressed as polish. Sound
 *    is strictly opt-in via the SFX toggle on the stage, persisted per rep
 *    in localStorage, and the volume ceiling is deliberately low.
 * 2. NO AUTOPLAY, structurally. The AudioContext is created lazily and only
 *    ever from inside a user gesture (the toggle click, or a one-time
 *    pointerdown unlock when the preference was already on) -- which is also
 *    what the platform's autoplay policy demands. Nothing constructs audio
 *    at import time.
 * 3. Sounds attach to the OPERATOR'S OWN ACTIONS only -- tap, focus flight,
 *    camera reset. Nothing ambient, nothing looping, nothing on data
 *    changes: the sound grammar mirrors the motion grammar (the rep's hand,
 *    echoed back).
 * 4. This module lives beside the WebGL stage and is called only from it,
 *    so reduced-motion users -- who never mount the stage -- are never asked
 *    to think about it.
 */

const KEY = "oasis.battlecard.sfx";
/** The ceiling on every envelope. HUD ticks sit UNDER a phone call. */
const GAIN = 0.045;

type SfxName = "tick" | "engage" | "disengage";

let ctx: AudioContext | null = null;
let enabled = false;
let unlockArmed = false;

if (typeof window !== "undefined") {
  try {
    enabled = window.localStorage.getItem(KEY) === "1";
  } catch {
    enabled = false;
  }
}

/** Create (or resume) the context. MUST be called from a user-gesture call
 *  stack the first time -- see armUnlock() for the already-enabled case. */
function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** One oscillator, one envelope. `freqTo` sweeps; `type` shapes the voice. */
function voice(c: AudioContext, type: OscillatorType, freq: number, freqTo: number, dur: number, peak: number, when = 0) {
  const t0 = c.currentTime + when;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqTo !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const PALETTE: Record<SfxName, (c: AudioContext) => void> = {
  /** A short glass tick: the tap itself. */
  tick: (c) => {
    voice(c, "sine", 1320, 1320, 0.06, GAIN);
    voice(c, "sine", 2640, 2640, 0.04, GAIN * 0.3);
  },
  /** The focus flight engaging: a quick rising sweep with a soft fifth. */
  engage: (c) => {
    voice(c, "sine", 320, 880, 0.16, GAIN);
    voice(c, "triangle", 480, 1320, 0.16, GAIN * 0.4, 0.02);
  },
  /** The camera letting go: the same gesture, downward. */
  disengage: (c) => {
    voice(c, "sine", 700, 360, 0.14, GAIN * 0.8);
  },
};

export const sfx = {
  get enabled() {
    return enabled;
  },
  /** Flip the preference. Called from the toggle's click handler, which is a
   *  user gesture -- so turning it ON also unlocks the context right here. */
  setEnabled(on: boolean) {
    enabled = on;
    try {
      window.localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* a rep with storage disabled just gets a session-scoped toggle */
    }
    if (on) ensureCtx();
  },
  /** For mounts where the preference was already on: arm a ONE-TIME unlock
   *  on the next pointerdown anywhere in the stage, because creating audio
   *  outside a gesture is blocked by autoplay policy (and rightly so).
   *
   *  Returns a DISARM the caller must run on unmount: `unlockArmed` is
   *  module-global, so a stage that unmounts before any gesture would
   *  otherwise leave the flag true against a dead listener, and every later
   *  stage would refuse to arm -- SFX showing "on" while permanently silent.
   *  (Codex review P2, 2026-09-01.) */
  armUnlock(el: HTMLElement): () => void {
    if (!enabled || unlockArmed || ctx) return () => {};
    unlockArmed = true;
    const onFirst = () => {
      unlockArmed = false;
      if (enabled) ensureCtx();
    };
    el.addEventListener("pointerdown", onFirst, { once: true, capture: true });
    return () => {
      unlockArmed = false;
      el.removeEventListener("pointerdown", onFirst, { capture: true });
    };
  },
  play(name: SfxName) {
    if (!enabled || !ctx || ctx.state !== "running") return;
    try {
      PALETTE[name](ctx);
    } catch {
      /* an exhausted audio device must never break the chart */
    }
  },
};
