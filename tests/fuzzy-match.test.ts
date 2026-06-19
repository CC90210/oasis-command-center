import assert from "node:assert/strict";
import { levenshtein, fuzzyScore, fuzzyMatches } from "../lib/fuzzy-match";

// Levenshtein basics
assert.equal(levenshtein("", "abc"), 3);
assert.equal(levenshtein("abc", "abc"), 0);
assert.equal(levenshtein("remmington", "remington"), 1);

// Substring = best (-1); prefix token = -0.5
assert.equal(fuzzyScore("rem", "Remington Builders"), -1, "substring is best");
assert.equal(fuzzyScore("buil", "Remington Builders"), -1);
assert.ok(fuzzyScore("remingto", "Remington Builders") < 0, "prefix/substring negative");

// Case-insensitive
assert.equal(fuzzyScore("REMINGTON", "remington builders"), -1);

// Typo-tolerant: a misspelling still matches the intended merchant
assert.ok(
  fuzzyMatches("remmington", "Remington Builders"),
  "one-char typo must still match",
);
assert.ok(fuzzyMatches("acme", "ACME Garage"), "case-insensitive match");

// Non-matches are rejected
assert.equal(fuzzyMatches("zzzzzz", "Remington Builders"), false, "garbage query rejected");
assert.ok(fuzzyScore("", "anything") === 0, "empty query is neutral");

// Ranking: closer match sorts ahead
const targets = ["Remington Builders", "Remy's Diner", "Acme Garage"];
const ranked = targets
  .map((t) => ({ t, s: fuzzyScore("remington", t) }))
  .sort((a, b) => a.s - b.s);
assert.equal(ranked[0].t, "Remington Builders", "closest match ranks first");

console.log("fuzzy-match tests passed");
