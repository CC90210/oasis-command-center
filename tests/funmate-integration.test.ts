import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSunbizApplicationForFunmate, renderFunmateSubmission } from "../lib/lenders/funmate-transform";

const transformed = transformSunbizApplicationForFunmate("app-123", {
  business_legal_name: "Example Holdings LLC",
  business_name: "Example Cafe",
  business_state: "FL",
  industry: "restaurant",
  time_in_business_months: 48,
  contact_name: "Morgan Example",
  email: "merchant@example.test",
  phone: "+15555550123",
  applicant_fico: 701,
  requested_amount: 75000,
  monthly_revenue: 125000,
  avg_daily_balance: 12000,
  position_count: 1,
});
assert.equal(transformed.business.legalName, "Example Holdings LLC");
assert.equal(transformed.funding.requestedAmount, 75000);
assert.equal(transformed.source, "sunbiz");

const rendered = renderFunmateSubmission(transformed, "Priority review requested.");
assert.match(rendered.subject, /^Funmate Submission \| Example Holdings LLC$/);
assert.match(rendered.text, /Priority review requested/);
assert.match(rendered.text, /SunBiz reference: app-123/);

assert.throws(
  () => transformSunbizApplicationForFunmate("bad", {}),
  /funmate_transform_missing:business_legal_name/,
);

const sunbizRoute = readFileSync("app/api/applications/[id]/shop-out/route.ts", "utf8");
assert.match(sunbizRoute, /funmate_lenders_require_funmate_route/);
const directSunbizRoute = readFileSync("app/api/applications/[id]/shop-out/run/route.ts", "utf8");
assert.match(directSunbizRoute, /funmate_lenders_require_funmate_route/);
const funmateRoute = readFileSync("app/api/applications/[id]/shop-out/funmate/route.ts", "utf8");
assert.match(funmateRoute, /funmate_route_requires_funmate_lenders/);
assert.match(funmateRoute, /email_identity:\s*"funmate"/);
const retryRoute = readFileSync(
  "app/api/applications/[id]/lender-threads/[threadId]/retry/route.ts",
  "utf8",
);
assert.match(retryRoute, /funmate_retry_requires_funmate_route/);

console.log("funmate-integration: all assertions passed");
