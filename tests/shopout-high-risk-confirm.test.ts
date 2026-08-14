import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync("components/shopping-out/ShoppingOutClient.tsx", "utf8");
const route = readFileSync("app/api/applications/[id]/shop-out/route.ts", "utf8");
const runEngine = readFileSync("lib/lenders/shop-out-run.ts", "utf8");

assert.match(client, /\.filter\(\(r\) => r\.recipient_email\)/, "high-risk contactable lenders may be preselected");
assert.doesNotMatch(client, /recipient_email && r\.blockers\.length === 0/, "high-risk lenders must not be filtered from defaults");
assert.match(client, /if \(highRiskSelected\.length > 0\)[\s\S]*setPendingConfirmation\(true\)/, "high-risk send requires a confirmation warning");
assert.match(client, /Override note \(optional\)/, "confirmation must not require an explanation");
assert.doesNotMatch(client, /overrideNote\.trim\(\)\.length < 5/, "empty optional note must not disable Proceed Anyway");

assert.match(route, /error: !row\.recipient_email \? "missing lender contact email" : undefined/, "server blocks only undeliverable lender rows");
assert.doesNotMatch(route, /match blocker\(s\)/i, "risk flags must not become thread send errors");
assert.doesNotMatch(runEngine, /error: `match_blocker:/, "alternate shop-out engine must not reject high-risk matches");

console.log("shopout-high-risk-confirm.test.ts: advisory warning flow verified");
