import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.join(process.cwd(), "components/renewals/RecordFundedDeal.tsx"),
  "utf8",
);
const routeSource = fs.readFileSync(
  path.join(process.cwd(), "app/api/renewals/route.ts"),
  "utf8",
);

assert.match(
  source,
  /onPointerDown=\{\(event\) => \{[\s\S]*?selectLead\(lead\)/,
  "pointer selection commits before the option can be dismissed",
);
assert.match(source, /createPortal\(/, "picker and drawer render outside page stacking contexts");
assert.match(source, /<aside[\s\S]*?role="dialog"/, "funding details open in a side drawer");
assert.match(source, /aria-modal="true"/, "funding dialog is announced as modal");
assert.match(source, /event\.key === "Escape"/, "funding dialog supports Escape");
assert.match(source, /event\.key === "ArrowDown"/, "picker supports keyboard navigation");
assert.match(source, /requestId !== requestRef\.current/, "stale search responses are ignored");
assert.match(source, /id="fd-term-value"[\s\S]*?required/, "term is required");
assert.match(source, /id="fd-factor-rate"[\s\S]*?required/, "factor rate is required");
assert.match(
  routeSource,
  /do \{[\s\S]*?\.range\(from, from \+ LEAD_SEARCH_PAGE_SIZE - 1\)[\s\S]*?from \+= LEAD_SEARCH_PAGE_SIZE;[\s\S]*?\} while \(true\)/,
  "renewal lead search pages through the full tenant lead directory",
);
assert.doesNotMatch(
  routeSource,
  /\.eq\("entity_type", "lead"\)[\s\S]{0,150}\.limit\(250\)/,
  "renewal lead search is not capped to the 250 most recently updated leads",
);

console.log("renewals-picker-interaction tests passed");
