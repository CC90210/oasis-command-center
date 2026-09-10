/**
 * The slugs scripts/seed-objection-catalog.ts writes into objection_catalog.
 * NO I/O, no import of the seed script itself: that script runs `main()` as
 * a module-level side effect (it loads env, argv-parses, and either dry-runs
 * or writes live data the moment it is imported), so pulling it into a test
 * or into ranking.ts would execute a seed run as a side effect of importing
 * a slug list. This file exists so that never has to happen.
 *
 * WHY THIS FILE EXISTS (task-7 fix round 1, finding F1). ranking.ts used to
 * hardcode a slug literal ("nephew-built-it") that did not match what the
 * seed actually wrote ("nephew-built-website"), and the test's own fixture
 * invented a THIRD spelling that agreed with neither. All three were wrong
 * in a mutually reinforcing way: the fixture made the test pass, the real
 * catalog made the rule a no-op, and nothing connected the three. This file
 * is the one list a slug has to match; ranking.ts's slug constant(s) are
 * asserted against it directly in tests/objection-ranking.test.ts, so a
 * rename on one side without the other fails loudly instead of silently
 * ranking wrong forever.
 *
 * Deliberately NOT the full UNIVERSAL_META / ANGLE_META metadata (family,
 * posture, label, meaning, prevent) -- that classification data has exactly
 * one home, scripts/seed-objection-catalog.ts, and duplicating it here would
 * just move the drift risk rather than remove it. Only the slug strings are
 * shared, because slugs are the one piece both the seed script and
 * ranking.ts independently need to agree on.
 *
 * scripts/seed-objection-catalog.ts imports this list too and asserts its
 * own computed slugs match it exactly (same set, either direction), so a
 * rename inside that script's UNIVERSAL_META/ANGLE_META blocks that forgets
 * to update this file fails the seed run itself, not just the ranking test.
 */
export const SEEDED_SLUGS = [
  "nephew-built-website",
  "no-budget",
  "just-send-email",
  "not-interested",
  "how-much-is-it",
  "call-back-later",
  "word-of-mouth",
  "facebook-page-is-enough",
  "conversion-plenty-of-calls",
  "trust-reviews-on-google",
  "design-customers-dont-care",
  "mobile-looks-fine",
  "content-everyone-knows-us",
  "performance-loads-fine-for-me",
  "discoverability-already-on-google",
] as const;

export type SeededSlug = (typeof SEEDED_SLUGS)[number];
