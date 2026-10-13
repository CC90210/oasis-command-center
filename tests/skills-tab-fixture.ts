/** tests/skills-tab-fixture.ts - one synthetic computer's Skills tab data (plan 3). No real prompt, path or merchant. */
import type { Op } from "../lib/skills/contract";
import type { ChangeRow, Computer, Library } from "../lib/skills/view";

/** 10:00 am in Toronto on 2026-10-12. */
export const NOW = "2026-10-12T14:00:00.000Z";

export const COMPUTER: Computer = {
  id: "pc-66997cf1", display_name: "Adon's PC", primary: true, revoked: false, rebuild_requested: false,
  last_checkin_at: "2026-10-12T06:04:00.000Z", last_checkin_outcome: "held", last_checkin_detail: "applied 1, held 1, failed 1, pruned 0",
};

export const LIB: Library = {
  skills: [
    { name: "graft", description: "Find code by symbol and trace who calls what.", kind: "installed", quarantined: false,
      capabilities: ["Finds the function behind a slow screen", "Traces every caller before a rename", "Maps a file's API in one call"],
      example_prompts: [{ prompt: "the owner search takes 4 seconds", adds: "finds the query and every caller in one call" }], tests: { n: 4, ok: 3 } },
    { name: "superpowers:systematic-debugging", description: "Find the root cause before fixing anything.", kind: "installed", quarantined: false,
      capabilities: [], example_prompts: [], tests: { n: 12, ok: 12 } },
    { name: "turso-cloud", description: "Turso Cloud databases and tokens.", kind: "library", quarantined: false,
      capabilities: ["Writes SQL that runs on Turso"], example_prompts: [], tests: null },
    { name: "hallmark", description: "Anti-slop design system.", kind: "installed", quarantined: false,
      capabilities: [], example_prompts: [], tests: { n: 0, ok: 0 } },
  ],
  labels: [
    { id: "debug", level: "broad", parent: null, name: "Something is broken, wrong, failing or behaving unexpectedly", meaning: "", examples: [] },
    { id: "debug-slow-query", level: "sub", parent: "debug", name: "Speed up a slow query", meaning: "", examples: [] },
    { id: "ui-build", level: "broad", parent: null, name: "Build or change anything with a visual surface", meaning: "", examples: [] },
    { id: "brand-new-kind", level: "broad", parent: null, name: "A kind with no short name yet", meaning: "", examples: [] },
  ],
  assignments: [
    { skill: "graft", label: "debug-slow-query", rank: "use-first" },
    { skill: "superpowers:systematic-debugging", label: "debug", rank: "use-first" },
    { skill: "turso-cloud", label: "debug-slow-query", rank: "also-helps" },
    { skill: "hallmark", label: "ui-build", rank: "use-first" },
    { skill: "not-installed-here", label: "ui-build", rank: "also-helps" },
  ],
  kinds: { debug: { n: 32, ok: 27 }, "ui-build": { n: 10, ok: 4 } },
  records_at: "2026-10-12T05:00:00.000Z",
};

const HELD_OPS: Op[] = [
  { op: "add-sub", id: "sales-offer-outreach-script", parent: "sales-offer", name: "Outreach scripts", meaning: "write a cold email or call script",
    phrasings: ["cold email script"], keywords: ["outreach"], examples: ["write a cold email for a roofer"] },
  { op: "assign", skill: "storybrand", label: "sales-offer-outreach-script", rank: "also-helps" },
  { op: "assign", skill: "graft", label: "debug", rank: "use-first" },
];

const base = { computer_id: COMPUTER.id, reason: "", worse: 0, better: 0, totals: {}, author: "adon", scope: "shared",
  created_at: "2026-10-11T12:00:00.000Z", ops: [] as Op[] };

export const CHANGES: ChangeRow[] = [
  { ...base, change_id: "ch-held", status: "held", description: "Outreach scripts", reason: "1 prompt routes worse", worse: 1, better: 1,
    updated_at: "2026-10-12T06:04:00.000Z", author: "apex", scope: COMPUTER.id, ops: HELD_OPS,
    totals: { "sales-offer": { n: 9, before: 7, after: 6 }, "new-feature-plan": { n: 14, before: 12, after: 13 } } },
  { ...base, change_id: "ch-failed", status: "failed", description: "Put tanstack-table in Charts", reason: "the router build refused it at go-live, nothing changed",
    updated_at: "2026-10-12T06:04:00.000Z" },
  { ...base, change_id: "ch-wait", status: "waiting", description: "Put graft in Fix something broken as use first", updated_at: "2026-10-12T13:00:00.000Z" },
  { ...base, change_id: "ch-applied", status: "applied", description: "Speed up a slow query", updated_at: "2026-10-10T06:04:00.000Z" },
  { ...base, change_id: "ch-old", status: "applied", description: "An old change", updated_at: "2026-09-01T06:04:00.000Z" },
  { ...base, change_id: "ch-other", computer_id: "pc-someone-else", status: "held", description: "Someone else's change", updated_at: "2026-10-12T06:04:00.000Z" },
];
