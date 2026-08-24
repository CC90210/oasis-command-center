/**
 * lib/web-leads/angles.ts — the one idea a rep opens with.
 *
 * Design spec 2026-08-24, §5. Seven angles, one per dimension, selected by
 * which dimension is losing the site the most composite points. NOT forty-nine:
 * a rep opens a call with a single idea, and a list of nine talking points is a
 * rep improvising a tenth.
 *
 * ═══ WHY THIS IS NOT GENERATED ══════════════════════════════════════════════
 *
 * A model writing per-lead sales copy will eventually assert "your site takes
 * eight seconds to load" about a site we measured at two, and a rep will say it
 * aloud to a stranger. That is the worst outcome this system can produce, and
 * it is not preventable by prompt. So this is a fixed table, same discipline as
 * remedies.ts, and it is unit-tested for completeness -- a dimension with no
 * angle is a hole in the product, not a cosmetic gap.
 *
 * Note the shape of what is written here: NOT ONE SENTENCE MENTIONS A NUMBER.
 * Every angle names a behaviour the prospect can check on their own phone while
 * the rep is talking. The measured numbers live in the audit and are rendered
 * beside this, from the audit, where they are true by construction. Copy that
 * quotes a measurement is copy that can be wrong about a specific business.
 *
 * ⚠️ COPY STATUS: hand-written, NOT yet reviewed by Adon. The spec (§5, §8.2)
 * says these need his voice and that the fastest path is him pitching once on a
 * recording so it can be written from the transcript. Until that happens this
 * is a competent placeholder in his register, not his words. It is rendered
 * verbatim, so replacing it is an edit to this file and nothing else.
 */

export type Angle = {
  /** One sentence, naming a specific failure. Read aloud, first. */
  opener: string;
  /** Why it matters in customers, not in points. */
  cost: string;
  /** The push-back this angle actually gets, and the answer to it. */
  objection: { says: string; response: string };
  /** What we would build, roughly, so it doubles as scope for the sale. */
  build: string;
};

/**
 * Keyed by the dimension keys JARVIS's quality-model.js emits: conversion,
 * trust, design, mobile, content, performance, discoverability.
 */
export const ANGLES: Record<string, Angle> = {
  conversion: {
    opener:
      "I had a look at your site. If somebody finds you on their phone, there is no straightforward way for them to actually call you from it.",
    cost:
      "Most people looking for a business like yours are on a phone and they are ready right then. A number they have to write down and dial by hand is a number a good share of them never dial.",
    objection: {
      says: "We get plenty of calls.",
      response:
        "You get the ones who worked for it. I am talking about the ones who did not, and you would never hear about either way.",
    },
    build:
      "Tap-to-call in the header on every page, a short form under it for the people who would rather write, and a call button that follows on mobile.",
  },

  trust: {
    opener:
      "Someone landing on your site for the first time has nothing on the page telling them anyone has hired you before.",
    cost:
      "A stranger deciding between you and the next name on the list is looking for a reason to trust one of you. Real customer quotes, a licence, a guarantee, that is the reason. With none of it on the page they go and look for it somewhere else, and somewhere else is where they find your competitor.",
    objection: {
      says: "Our reviews are all on Google.",
      response:
        "They are, and that is a trip off your site to go find them. Half the point is that the proof sits where the decision happens.",
    },
    build:
      "Your best reviews pulled onto the site itself with names and locations, your licence and insurance shown plainly, and whatever guarantee you already give in writing.",
  },

  design: {
    opener:
      "Your site is doing the job, but it looks like it was built a while ago, and that is the first thing anyone sees before they read a word.",
    cost:
      "People decide whether a business is still going and still good in about a second, off nothing but how the page looks. A dated site does not read as thrifty, it reads as a business that might not pick up the phone.",
    objection: {
      says: "Our customers do not care what it looks like.",
      response:
        "Your existing customers do not, they already know you. This is about the person who has never heard of you and has four other tabs open.",
    },
    build:
      "A rebuild on your own look, current typography and layout, your real photos rather than stock, and your logo used properly throughout.",
  },

  mobile: {
    opener:
      "Pull your own site up on your phone while we talk. It was not built for that screen, and that is where nearly everyone is seeing it.",
    cost:
      "On a phone a desktop site means pinching and dragging just to read a sentence. People do not do that. They go back to the search results and pick somebody whose page just worked.",
    objection: {
      says: "It looks fine on my phone.",
      response:
        "Try tapping the menu and then finding your phone number without zooming. That is the bit that costs you.",
    },
    build:
      "A layout that reflows properly on every screen size, a menu built for a thumb, and the phone number reachable without a single pinch.",
  },

  content: {
    opener:
      "I read your homepage and I still could not tell you exactly what you do, where you do it, or roughly what it costs.",
    cost:
      "Somebody comparing three businesses gives each one a few seconds to answer those three questions. The one that answers them gets the call, even when it is not the best of the three.",
    objection: {
      says: "Everyone in our area already knows what we do.",
      response:
        "The people who already know you are not the ones on the site. The ones on the site are the ones who do not.",
    },
    build:
      "A homepage that says what you do, the area you cover and how pricing works, plus a page per service so each one can be found on its own.",
  },

  performance: {
    opener:
      "Your site is slow to come up, and on some setups the browser is warning people about it before they even see the page.",
    cost:
      "A page that takes its time loses people before it has said anything, and a browser warning about security loses the rest. Neither one gives you any signal, they simply leave.",
    objection: {
      says: "It loads fine for me.",
      response:
        "It does, your browser has it saved. Try it on data with your phone, on a page you have not opened before.",
    },
    build:
      "A proper certificate, images compressed to a sensible size, and the code that holds up the first paint moved out of the way.",
  },

  discoverability: {
    opener:
      "Your site is missing the basics that let search engines and map listings tell people what you are and where you are.",
    cost:
      "Without those, you are relying on people already knowing your name and typing it in. Everyone searching for what you do rather than who you are never reaches you at all.",
    objection: {
      says: "We are already on Google.",
      response:
        "You are listed, which is not the same as being findable for the thing you actually sell. Those are two separate pieces and only one of them is done.",
    },
    build:
      "Titles and descriptions on every page, local-business markup so the map listing and the site agree, a sitemap, and analytics so you can finally see what is arriving.",
  },
};

/**
 * The dimension losing the site the most composite points, which is the angle a
 * rep opens with.
 *
 * WEIGHTED, NOT RAW: dimensions normalise to 100 independently and then carry
 * very different weights into the composite (conversion 0.28, discoverability
 * 0.05). A discoverability 20 and a conversion 60 both look bad, but fixing the
 * conversion 60 is worth eleven composite points and fixing the discoverability
 * 20 is worth four. Ranking on the raw score sends a rep into the smaller
 * conversation and, worse, into the smaller build.
 *
 * TIEBREAK toward `conversion`, then `trust`, per the spec: those two convert
 * into money the fastest for the prospect and are the cheapest for us to build,
 * so a genuine tie should resolve toward the sale that closes.
 */
const TIEBREAK = ["conversion", "trust"];

export function recoverablePoints(d: { score: number; weight: number }): number {
  return Math.max(0, 100 - d.score) * d.weight;
}

export function selectAngle(
  dimensions: { key: string; label: string; score: number; weight: number }[],
): { key: string; label: string; angle: Angle } | null {
  const ranked = [...dimensions]
    .filter((d) => ANGLES[d.key])
    .sort((a, b) => {
      const diff = recoverablePoints(b) - recoverablePoints(a);
      if (Math.abs(diff) > 1e-9) return diff;
      const ai = TIEBREAK.indexOf(a.key);
      const bi = TIEBREAK.indexOf(b.key);
      // Not in the tiebreak list sorts after both entries in it.
      return (ai === -1 ? TIEBREAK.length : ai) - (bi === -1 ? TIEBREAK.length : bi);
    });
  const winner = ranked[0];
  if (!winner) return null;
  return { key: winner.key, label: winner.label, angle: ANGLES[winner.key] };
}

const anglesModule = { ANGLES, selectAngle };
export default anglesModule;
