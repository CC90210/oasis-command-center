import assert from "node:assert/strict";
import { stripDashes, matchLenderNames } from "../lib/integrations/blast-safety-core";

// Outbound text-blast safety guard (P1e). Locks the two merchant-facing rules:
// no lender names (hard guard) + no em dashes.

// --- stripDashes ---
assert.equal(stripDashes("Fund $10k — fast – today"), "Fund $10k - fast - today", "em + en dashes → hyphens");
assert.equal(stripDashes("no dashes here"), "no dashes here", "no-op when clean");

// --- matchLenderNames (case-insensitive, word-boundary, >=3 chars) ---
assert.deepEqual(matchLenderNames("Get funded by Olympus today", ["Olympus", "Fora"]), ["Olympus"], "single hit");
assert.deepEqual(matchLenderNames("OLYMPUS funding", ["Olympus"]), ["Olympus"], "case-insensitive");
assert.deepEqual(matchLenderNames("via Forward Financing now", ["Forward Financing"]), ["Forward Financing"], "multi-word name");
assert.deepEqual(matchLenderNames("rapidly growing business", ["Rapid"]), [], "word-boundary: no false positive in 'rapidly'");
assert.deepEqual(matchLenderNames("SunBiz can fund you", ["DLP", "CFG", "Olympus"]), [], "clean message → no hits");
assert.deepEqual(matchLenderNames("on the go", ["on"]), [], "names under 3 chars are skipped");
assert.deepEqual(matchLenderNames("DLP and CFG both", ["DLP", "CFG"]), ["DLP", "CFG"], "multiple hits, deduped order");
assert.deepEqual(matchLenderNames("anything", []), [], "no lender list → no hits");

console.log("ok blast-safety");
