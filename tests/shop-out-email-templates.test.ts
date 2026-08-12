import assert from "node:assert/strict";
import { composeShopOutBody, normalizeShopOutText, renderShopOutHtml, SHOP_OUT_EMAIL_TEMPLATES } from "../lib/lenders/shop-out-email-templates";

assert.equal(SHOP_OUT_EMAIL_TEMPLATES.length, 3);
for (const template of SHOP_OUT_EMAIL_TEMPLATES) {
  assert.match(template.body, /\{\{application\.business_name\}\}/);
  assert.match(template.body, /\{\{application\.monthly_revenue_display\}\}/);
  assert.match(template.body, /\{\{application\.position_count_display\}\}/);
  assert.match(template.body, /\{\{application\.requested_amount_display\}\}/);
  assert.match(template.body, /bank statements/i);
  assert.match(template.body, /application/i);
  assert.match(template.body, /SunBiz Submissions/);
  assert.doesNotMatch(template.body, /\{\{agent\.first_name\}\}/);
}
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
);
assert.match(html, /SUN<span[^>]*>BIZ<\/span> FUNDING/);
assert.match(html, /Lender Submissions/);
assert.match(html, /SunBiz Submissions/);
assert.match(html, /desk@sunbizfunding\.com/);
assert.equal((html.match(/SunBiz Submissions/g) || []).length, 1, "HTML must not duplicate the signature");
assert.match(html, /A&amp;B &lt;Holdings&gt;/, "operator copy must be HTML escaped");
assert.doesNotMatch(html, /A&B <Holdings>/);
console.log("shop-out-email-templates.test.ts: all assertions passed");
