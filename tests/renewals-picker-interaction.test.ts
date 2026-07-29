import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.join(process.cwd(), "components/renewals/RecordFundedDeal.tsx"),
  "utf8",
);

assert.match(
  source,
  /onPointerDown=\{\(event\) => \{[\s\S]*?chooseLead\(lead\)/,
  "pointer selection commits before the option can be dismissed",
);
assert.match(source, /role="dialog"/, "funding details open in a dialog");
assert.match(source, /aria-modal="true"/, "funding dialog is announced as modal");
assert.match(source, /event\.key === "Escape"/, "funding dialog supports Escape");
assert.match(source, /id="fd-term"[\s\S]*?required/, "term is required");
assert.match(source, /id="fd-factor"[\s\S]*?required/, "factor rate is required");

console.log("renewals-picker-interaction tests passed");
