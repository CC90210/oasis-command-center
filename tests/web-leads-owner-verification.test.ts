import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const card = readFileSync(join(process.cwd(), "components/web-leads/LeadCards.tsx"), "utf8");
// "Confirmed" must be reachable ONLY from the confirmed state. If this ever
// renders for an unverified lead, the badge is lying to a rep on a live call.
assert.match(card, /l\.ownerVerification === "confirmed"[\s\S]{0,200}Confirmed/);
assert.match(card, /lookup_failed[\s\S]{0,200}Not checked/);
assert.match(card, /\{l\.ownerEvidence \?/, "the evidence sentence must render");
console.log("web-leads-owner-verification ok");
