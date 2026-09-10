/**
 * Seeds the objection catalog from the hand-written copy in
 * lib/web-leads/angles.ts. IDEMPOTENT: re-running updates wording in place and
 * never duplicates a slug.
 *
 * WHY A SCRIPT AND NOT THE MIGRATION. The wording is the product here, and it
 * must stay reviewable in a diff by a human who is not reading SQL. It also
 * changes on a different clock from the schema.
 *
 * angles.ts REMAINS THE SOURCE OF THE ANGLE SYSTEM. This copies from it once
 * into the database; it does not make the database a second live source of
 * angle copy. The seven angle objections keep their `dimension` so the ranker
 * can favour the one matching the opener the rep is actually using.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/seed-objection-catalog.ts
 *   node --conditions=react-server --import tsx scripts/seed-objection-catalog.ts --dry-run
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Mirrors scripts/audit-texttorrent.ts's loadEnv(), not the loadEnvFile()
 * used by migrate-application-chase.ts / canary-application-chase.ts /
 * cancel-offboard-drip-runs.ts. Those three read TURSO_DATABASE_URL and
 * TURSO_AUTH_TOKEN under those exact names and leave EMPIRE_DATA_BACKEND
 * alone, which is not this file's shape: the agents env file stores the
 * database URL as TURSO_BRAVO_EMPIRE_URL, and getServiceSupabase() only
 * routes to Turso when BOTH EMPIRE_DATA_BACKEND === "turso_cloud" AND
 * tursoConfigured() (i.e. TURSO_DATABASE_URL + TURSO_AUTH_TOKEN under THOSE
 * names) hold -- see lib/supabase-server.ts. Without the remap and the
 * explicit backend flag, tursoConfigured() reads unset vars and
 * getServiceSupabase() falls through to the Supabase branch, which throws
 * because Supabase is retired and no BRAVO_SUPABASE_* creds exist.
 *
 * Deliberately does NOT copy audit-texttorrent.ts's BRAVO_FIELD_ENCRYPTION_KEY
 * line: that script decrypts stored integration credentials, this one
 * decrypts nothing, and pulling a key this script has no use for is scope
 * it doesn't need.
 *
 * Forcing EMPIRE_DATA_BACKEND = "turso_cloud" unconditionally (not just when
 * unset) is deliberate, same as the sibling: Supabase is retired across this
 * estate, so there is no live fallback for this to silently take instead --
 * an unset/wrong value here is the throw branch, never a quiet write to a
 * cancelled database.
 */
function loadEnv(): void {
  let txt = "";
  try {
    txt = readFileSync("C:/Users/echel/JARVIS/.env.agents", "utf8");
  } catch {
    return;
  }
  const env: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    env[k.trim()] = rest.join("=").trim().replace(/^"|"$/g, "");
  }
  if (env.TURSO_BRAVO_EMPIRE_URL) process.env.TURSO_DATABASE_URL = env.TURSO_BRAVO_EMPIRE_URL;
  if (env.TURSO_AUTH_TOKEN) process.env.TURSO_AUTH_TOKEN = env.TURSO_AUTH_TOKEN;
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
}
loadEnv();

// OBJECTIONS/ANGLES/types are pure data/type modules with no imports of their
// own (verified: neither lib/web-leads/angles.ts nor
// lib/web-leads/objections/types.ts imports anything), so a static import of
// them carries no risk of reaching supabase-server.ts before loadEnv has
// run. getServiceSupabase and WEBDEV_TENANT_ID are NOT imported statically
// here for exactly that reason -- lib/web-leads/data.ts (WEBDEV_TENANT_ID's
// home) itself statically imports @/lib/supabase-server, and a static import
// anywhere in this file would be hoisted and evaluated before loadEnv's call
// above runs. Both are imported dynamically inside main() instead, after the
// env is loaded.
import { OBJECTIONS, ANGLES } from "@/lib/web-leads/angles";
import type { ObjectionFamily, ObjectionPosture, WebsitePremise } from "@/lib/web-leads/objections/types";
import { SEEDED_SLUGS } from "@/lib/web-leads/objections/seed-slugs";

const DRY = process.argv.includes("--dry-run");
const SEEDED_BY = "seed:angles.ts";

/**
 * Family and posture for each of the eight universal objections, assigned by
 * hand. `says` is the join key back to OBJECTIONS, matched exactly, so a
 * reworded objection in angles.ts fails this script loudly rather than seeding
 * a half-classified row.
 *
 * Family reasoning, kept short because the report carries the long version:
 * "already have X elsewhere that does this job" reads as already_handled
 * (nephew's website, word of mouth, the Facebook page); a reflexive get-off-
 * the-phone line with no real reason reads as brush_off (send an email, not
 * interested, call back later); money reads as no_money whether it's a
 * refusal or a genuine price question.
 *
 * Posture reasoning: read what the response DOES, not what would be tidy.
 * Several open with an acknowledgement and then pivot to a new, specific
 * claim -- that is agree_and_redirect. Two are built entirely around asking
 * the prospect a diagnostic question rather than asserting anything --
 * that is question_back. The price question gets a real number scoped to
 * their situation -- reframe_the_cost. "Not interested" is answered by
 * literally offering to leave ("...or should I leave it?") -- take_it_away.
 *
 * `premise` (added by the final whole-branch review, 2026-09-10) is what the
 * WORDING assumes about the lead's website, and it is written here, beside
 * the wording, because that is the only place anyone knows it. It is omitted
 * wherever the objection does not care -- an omission means premise-neutral,
 * never "unclassified, guess". See WebsitePremise in
 * lib/web-leads/objections/types.ts and the no-website block in
 * lib/web-leads/objections/ranking.ts.
 */
const UNIVERSAL_META: { says: string; slug: string; family: ObjectionFamily; posture: ObjectionPosture; label: string; premise?: WebsitePremise }[] = [
  {
    says: "We already have a website. My nephew built it.",
    slug: "nephew-built-website",
    family: "already_handled",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    // Names an incumbent website outright. A lead with no site cannot say it.
    premise: "requires_site",
  },
  {
    says: "We have no budget for that right now.",
    slug: "no-budget",
    family: "no_money",
    posture: "question_back",
    label: "Question it back",
  },
  {
    says: "Just send me an email.",
    slug: "just-send-email",
    family: "brush_off",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
  },
  {
    says: "We are not interested.",
    slug: "not-interested",
    family: "brush_off",
    posture: "take_it_away",
    label: "Take it away",
  },
  {
    says: "How much is it?",
    slug: "how-much-is-it",
    family: "no_money",
    posture: "reframe_the_cost",
    label: "Reframe the cost",
  },
  {
    says: "Call me back in a few months.",
    slug: "call-back-later",
    family: "brush_off",
    posture: "question_back",
    label: "Question it back",
  },
  {
    says: "We get all our work by word of mouth.",
    slug: "word-of-mouth",
    family: "already_handled",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    // The channel the owner believes replaces a website, and the single most
    // likely first objection from a business that never built one.
    premise: "substitute",
  },
  {
    says: "We have a Facebook page, that does the job.",
    slug: "facebook-page-is-enough",
    family: "already_handled",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    // Same shape as word-of-mouth: a named stand-in FOR a website, so it is
    // more likely from a lead with no site, not less.
    premise: "substitute",
  },
];

type SeedRow = {
  slug: string; says: string; meaning: string; prevent: string;
  family: ObjectionFamily; source: string | null; dimension: string | null;
  websitePremise: WebsitePremise | null;
  answer: { label: string; body: string; posture: ObjectionPosture };
};

function universalRows(): SeedRow[] {
  return OBJECTIONS.map((o) => {
    const meta = UNIVERSAL_META.find((m) => m.says === o.says);
    if (!meta) {
      throw new Error(
        `no UNIVERSAL_META entry for objection ${JSON.stringify(o.says)}. ` +
          `Add one rather than guessing a family: an unclassified objection ranks wrong for every lead.`,
      );
    }
    return {
      slug: meta.slug,
      says: o.says,
      meaning: o.meaning,
      prevent: o.prevent,
      family: meta.family,
      source: o.source ?? null,
      dimension: null,
      websitePremise: meta.premise ?? null,
      answer: { label: meta.label, body: o.response, posture: meta.posture },
    };
  });
}

/**
 * The seven angle objections. Each belongs to one audit dimension and carries
 * only a `says` and a `response` in angles.ts, so `meaning` and `prevent` are
 * written here rather than invented per run. They are marked so a human can
 * find and improve them in Phase 2's library.
 *
 * Family follows the same "already have X elsewhere" vs "there's no real
 * problem" split as the universal set: trust/content/discoverability cite an
 * existing asset (off-site reviews, local reputation, a Google listing) that
 * supposedly already covers the gap, so already_handled; design/mobile/
 * performance/conversion deny the underlying problem exists at all
 * ("customers don't care", "looks fine", "loads fine", "we get plenty of
 * calls"), so no_need.
 *
 * conversion was reclassified already_handled -> no_need in task-7 fix round
 * 1 (finding F2): "we get plenty of calls" is not citing a stand-in asset
 * that already does this job, it is "my own experience says nothing is
 * broken" -- structurally identical to mobile-looks-fine and
 * performance-loads-fine-for-me, and it is almost exactly what
 * ranking.ts's overallScore >= 75 rule describes ("a site that already
 * scores well earns its owner the right to say the phone rings fine, which
 * is the hardest version of no_need to answer").
 *
 * Posture follows the same read-the-response rule: conversion, trust,
 * design, content and discoverability each open by conceding the claim and
 * then pivot to a specific, previously-unstated group or distinction --
 * agree_and_redirect. mobile and performance don't concede anything; they
 * hand the test back to the prospect to run themselves ("try the menu",
 * "try it on your phone, on data") -- question_back.
 *
 * `premise` reasoning (final whole-branch review, 2026-09-10). Four of these
 * seven deny a fault in a site that EXISTS -- design ("what IT looks like"),
 * mobile ("IT looks fine on my phone"), performance ("IT loads fine for me")
 * and conversion. Conversion's `says` reads website-neutral on its own, but
 * its authored answer, meaning and prevent are entirely about what a phone
 * visitor does ON THE PAGE and the caller who gave up before dialing; handed
 * to a lead with no page, the card asks the rep to read a line about a page
 * that does not exist. All four are `requires_site`.
 *
 * The other three (trust, content, discoverability) are NOT marked
 * `substitute`, deliberately, even though each cites an off-site asset.
 * `substitute` means "this is why I never built a site", and these three are
 * dimension-scoped deflections authored as the push-back to a specific audit
 * angle -- "we are already on Google" answers "your site is not findable".
 * A no-website lead CAN say them, so they are not `requires_site` either.
 * Premise-neutral is the honest classification, and it leaves them ranked on
 * family base: immediately behind the open five, not buried.
 */
const ANGLE_META: Record<string, { slug: string; family: ObjectionFamily; posture: ObjectionPosture; label: string; meaning: string; prevent: string; premise?: WebsitePremise }> = {
  conversion: {
    slug: "conversion-plenty-of-calls",
    family: "no_need",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    meaning:
      "Call volume proves the page works for the people willing to fight for it. It says nothing about the ones who gave up before dialing, and that group never shows up as a complaint.",
    prevent:
      "Walk them through what a phone visitor actually does on the page during the diagnostic, before pitching, so the invisible non-caller is already on the table when this objection would otherwise land.",
    premise: "requires_site",
  },
  trust: {
    slug: "trust-reviews-on-google",
    family: "already_handled",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    meaning:
      "True, and beside the point. It locates the proof one click away from the moment somebody is actually deciding, which is exactly when people don't take the extra click.",
    prevent:
      "Ask what makes them pick one of three options during the diagnostic, before pitching the fix, so the gap between 'the proof exists' and 'the proof is on the page' is already theirs to name, not yours.",
  },
  design: {
    slug: "design-customers-dont-care",
    family: "no_need",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    meaning:
      "Correct about existing customers, and a case of survivorship bias: people who already trust the business were never going to be lost over a dated page in the first place.",
    prevent:
      "Anchor the diagnostic on a stranger's first second, not the owner's own experience of the site, so 'my customers don't care' has nothing left to attach to.",
    premise: "requires_site",
  },
  mobile: {
    slug: "mobile-looks-fine",
    family: "no_need",
    posture: "question_back",
    label: "Question it back",
    meaning:
      "Almost always tested on a saved, logged-in, familiar path rather than the cold path a first-time visitor takes, so 'fine' describes the tester's experience, not a stranger's.",
    prevent:
      "Have them attempt the task live on their own phone during the diagnostic, so they find the friction themselves before objecting to a claim about it.",
    premise: "requires_site",
  },
  content: {
    slug: "content-everyone-knows-us",
    family: "already_handled",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    meaning:
      "Locally true and irrelevant to anyone who hasn't moved in yet or hasn't met them yet. It mistakes the audience that already trusts them for the audience the site exists to reach.",
    prevent:
      // NO `--` IN SEEDED COPY. Every string on these rows renders verbatim on
      // the card (ObjectionCard.tsx holds no copy of its own), so a `--` typed
      // as a dash substitute reaches a rep as two literal hyphens. The project
      // rule bans em dashes; `--` is not the workaround for it. Commas and
      // full stops are.
      "Anchor the diagnostic on someone new to the area or the business, so the objection's premise, that everyone already knows, is pre-empted before it's said.",
  },
  performance: {
    slug: "performance-loads-fine-for-me",
    family: "no_need",
    posture: "question_back",
    label: "Question it back",
    meaning:
      "The owner's own browser has the site cached from the last visit, so their lived experience of speed is structurally unlike a first-time visitor's on a cold connection.",
    prevent:
      "Ask them to load it fresh on mobile data during the call rather than asserting a load time, so the diagnostic itself defeats this objection before it can be raised.",
    premise: "requires_site",
  },
  discoverability: {
    slug: "discoverability-already-on-google",
    family: "already_handled",
    posture: "agree_and_redirect",
    label: "Agree, then redirect",
    meaning:
      "Being listed and being findable for what they actually sell are two different systems. 'Already on Google' conflates a directory entry with search visibility for the service itself.",
    prevent:
      "Ask where they'd rank for the service, not their name, during the diagnostic, so the gap between listed and findable surfaces before the objection does.",
  },
};

function angleRows(): SeedRow[] {
  return Object.entries(ANGLES).map(([key, angle]) => {
    const meta = ANGLE_META[key];
    if (!meta) throw new Error(`no ANGLE_META entry for dimension ${key}`);
    return {
      slug: meta.slug,
      says: angle.objection.says,
      meaning: meta.meaning,
      prevent: meta.prevent,
      family: meta.family,
      source: null,
      dimension: key,
      websitePremise: meta.premise ?? null,
      answer: { label: meta.label, body: angle.objection.response, posture: meta.posture },
    };
  });
}

async function main() {
  const rows = [...universalRows(), ...angleRows()];
  const slugs = rows.map((r) => r.slug);
  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupes.length) throw new Error(`duplicate slugs in seed: ${dupes.join(", ")}`);

  // Drift guard, the other direction of task-7 fix round 1's finding F1:
  // lib/web-leads/objections/seed-slugs.ts's SEEDED_SLUGS is the list
  // ranking.ts's slug constant(s) are checked against. If UNIVERSAL_META or
  // ANGLE_META above is edited to rename a slug without updating that file
  // too, the two lists disagree and THIS throws, rather than the rename
  // silently shipping and only ranking.ts's guard test catching it later (or
  // not, if nobody happens to run it). Order-independent: same set, either
  // direction.
  const seededSet = new Set<string>(SEEDED_SLUGS);
  const rowSet = new Set(slugs);
  const missingFromSeedSlugs = slugs.filter((s) => !seededSet.has(s));
  const missingFromRows = SEEDED_SLUGS.filter((s) => !rowSet.has(s));
  if (missingFromSeedSlugs.length || missingFromRows.length) {
    throw new Error(
      `seed slugs disagree with lib/web-leads/objections/seed-slugs.ts's SEEDED_SLUGS. ` +
        `In rows but not SEEDED_SLUGS: ${JSON.stringify(missingFromSeedSlugs)}. ` +
        `In SEEDED_SLUGS but not rows: ${JSON.stringify(missingFromRows)}. ` +
        `Update both together -- this is exactly the drift that made ranking.ts's ` +
        `builder/no-website rules silent no-ops (task-7 fix round 1, finding F1).`,
    );
  }

  console.log(`[seed] ${rows.length} objections (${OBJECTIONS.length} universal + ${Object.keys(ANGLES).length} angle)`);
  if (DRY) {
    for (const r of rows) {
      console.log(
        `  ${r.slug.padEnd(34)} ${r.family.padEnd(16)} ${(r.websitePremise ?? "neutral").padEnd(14)} ${r.says.slice(0, 50)}`,
      );
    }
    return;
  }

  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const { WEBDEV_TENANT_ID } = await import("@/lib/web-leads/data");
  const db = getServiceSupabase();
  const nowIso = new Date().toISOString();

  for (const r of rows) {
    const existing = await db
      .from("objection_catalog")
      .select("id")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("slug", r.slug)
      .maybeSingle();
    if (existing.error) throw new Error(`catalog_lookup_failed ${r.slug}: ${existing.error.message}`);

    const objectionId = (existing.data as { id: string } | null)?.id || randomUUID();
    const base = {
      tenant_id: WEBDEV_TENANT_ID,
      slug: r.slug,
      says: r.says,
      meaning: r.meaning,
      prevent: r.prevent,
      family: r.family,
      source: r.source,
      dimension: r.dimension,
      // Written on every row on every run, including as an explicit null, so a
      // re-classification (substitute -> neutral, say) actually CLEARS the old
      // value instead of leaving a stale one behind on an idempotent re-seed.
      website_premise: r.websitePremise,
      status: "approved",
      origin: "seed",
      created_by: SEEDED_BY,
      approved_by: SEEDED_BY,
      approved_at: nowIso,
      updated_at: nowIso,
    };

    if (existing.data) {
      const upd = await db.from("objection_catalog").update(base)
        .eq("tenant_id", WEBDEV_TENANT_ID).eq("id", objectionId);
      if (upd.error) throw new Error(`catalog_update_failed ${r.slug}: ${upd.error.message}`);
    } else {
      const ins = await db.from("objection_catalog").insert({ ...base, id: objectionId, created_at: nowIso });
      if (ins.error) throw new Error(`catalog_insert_failed ${r.slug}: ${ins.error.message}`);
    }

    // Clear, then set. NEVER an upsert with a conflict target: the default
    // index is PARTIAL, and project doctrine records that upsert-on-conflict
    // against a partial unique index fails silently through PostgREST.
    const clear = await db.from("objection_response").update({ is_default: 0, updated_at: nowIso })
      .eq("tenant_id", WEBDEV_TENANT_ID).eq("objection_id", objectionId);
    if (clear.error) throw new Error(`response_clear_failed ${r.slug}: ${clear.error.message}`);

    const existingResp = await db
      .from("objection_response")
      .select("id")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("objection_id", objectionId)
      .eq("posture", r.answer.posture)
      .maybeSingle();
    if (existingResp.error) throw new Error(`response_lookup_failed ${r.slug}: ${existingResp.error.message}`);

    const respBase = {
      tenant_id: WEBDEV_TENANT_ID,
      objection_id: objectionId,
      label: r.answer.label,
      body: r.answer.body,
      posture: r.answer.posture,
      is_default: 1,
      status: "approved",
      approved_by: SEEDED_BY,
      approved_at: nowIso,
      updated_at: nowIso,
    };

    if (existingResp.data) {
      const upd = await db.from("objection_response").update(respBase)
        .eq("tenant_id", WEBDEV_TENANT_ID).eq("id", (existingResp.data as { id: string }).id);
      if (upd.error) throw new Error(`response_update_failed ${r.slug}: ${upd.error.message}`);
    } else {
      const ins = await db.from("objection_response").insert({ ...respBase, id: randomUUID(), created_at: nowIso });
      if (ins.error) throw new Error(`response_insert_failed ${r.slug}: ${ins.error.message}`);
    }

    console.log(`  seeded ${r.slug}`);
  }

  console.log("[seed] done");
}

main().catch((err) => {
  console.error("[seed] FAILED", err instanceof Error ? err.message : err);
  process.exit(1);
});
