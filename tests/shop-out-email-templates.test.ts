import assert from "node:assert/strict";
import { composeShopOutBody, normalizeShopOutText, PLAIN_SHOP_OUT_MARKER, renderShopOutHtml, resolveShopOutPresentation, SHOP_OUT_EMAIL_TEMPLATES } from "../lib/lenders/shop-out-email-templates";

assert.equal(SHOP_OUT_EMAIL_TEMPLATES.length, 4);
for (const template of SHOP_OUT_EMAIL_TEMPLATES.filter((template) => template.id !== "plain")) {
  assert.match(template.body, /\{\{application\.business_name\}\}/);
  assert.match(template.body, /\{\{application\.monthly_revenue_display\}\}/);
  assert.match(template.body, /\{\{application\.position_count_display\}\}/);
  assert.match(template.body, /\{\{application\.requested_amount_display\}\}/);
  assert.match(template.body, /bank statements/i);
  assert.match(template.body, /application/i);
  assert.match(template.body, /SunBiz Submissions/);
  assert.doesNotMatch(template.body, /\{\{agent\.first_name\}\}/);
}
const plain = SHOP_OUT_EMAIL_TEMPLATES.find((template) => template.id === "plain");
assert.ok(plain?.body.startsWith(PLAIN_SHOP_OUT_MARKER));
assert.deepEqual(resolveShopOutPresentation(plain?.body || ""), {
  text: "Please see application and statements attached. Thanks",
  branded: false,
});
assert.deepEqual(resolveShopOutPresentation("Regular submission"), {
  text: "Regular submission",
  branded: true,
});
const composed = composeShopOutBody(SHOP_OUT_EMAIL_TEMPLATES[0].body, "Strong August MTD.");
assert.match(composed, /Business:/);
assert.match(composed, /Additional context:\nStrong August MTD\.\n\nSunBiz Submissions\nSunBiz Funding$/);
assert.equal(composeShopOutBody(SHOP_OUT_EMAIL_TEMPLATES[0].body, "  "), SHOP_OUT_EMAIL_TEMPLATES[0].body);

assert.equal(
  normalizeShopOutText("New submission attached.\n\nMatt\nSunBiz Funding", "Matt"),
  "New submission attached.\n\nSunBiz Submissions\nSunBiz Funding",
  "legacy personalized signatures must become the shared lender identity",
);
assert.equal(
  normalizeShopOutText("Custom lender note.\n\nRegards,\nMatt", "Matt"),
  "Custom lender note.\n\nSunBiz Submissions\nSunBiz Funding",
  "custom body signatures must not expose the operator",
);
assert.equal(
  normalizeShopOutText("New submission attached.\n\nMatt\nSunBiz Funding\n\nAdditional context:\nStrong file."),
  "New submission attached.\n\nAdditional context:\nStrong file.\n\nSunBiz Submissions\nSunBiz Funding",
  "notes must stay in the body and the shared signature must remain last",
);
const html = renderShopOutHtml(
  "New submission attached.\n\nBusiness: A&B <Holdings>\n\nSunBiz Submissions\nSunBiz Funding",
  "desk@sunbizfunding.com",
  2,
);
assert.match(html, /SUN<span[^>]*>BIZ<\/span> FUNDING/);
assert.match(html, /Business Funding &bull; Built Around Your Cash Flow/);
assert.match(html, /SunBiz Funding LLC/);
assert.match(html, /https:\/\/sunbizfunding\.com/);
assert.match(html, /shared submissions inbox/);
assert.match(html, /SunBiz Submissions/);
assert.match(html, /desk@sunbizfunding\.com/);
assert.match(html, /A&amp;B &lt;Holdings&gt;/, "operator copy must be HTML escaped");
assert.doesNotMatch(html, /A&B <Holdings>/);
console.log("shop-out-email-templates.test.ts: all assertions passed");
