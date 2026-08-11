import assert from "node:assert/strict";
import { composeShopOutBody, SHOP_OUT_EMAIL_TEMPLATES } from "../lib/lenders/shop-out-email-templates";

assert.equal(SHOP_OUT_EMAIL_TEMPLATES.length, 3);
for (const template of SHOP_OUT_EMAIL_TEMPLATES) {
  assert.match(template.body, /\{\{application\.business_name\}\}/);
  assert.match(template.body, /\{\{application\.monthly_revenue_display\}\}/);
  assert.match(template.body, /\{\{application\.position_count_display\}\}/);
  assert.match(template.body, /\{\{application\.requested_amount_display\}\}/);
  assert.match(template.body, /bank statements/i);
  assert.match(template.body, /application/i);
}
const composed = composeShopOutBody(SHOP_OUT_EMAIL_TEMPLATES[0].body, "Strong August MTD.");
assert.match(composed, /Business:/);
assert.match(composed, /Additional context:\nStrong August MTD\.$/);
assert.equal(composeShopOutBody(SHOP_OUT_EMAIL_TEMPLATES[0].body, "  "), SHOP_OUT_EMAIL_TEMPLATES[0].body);
console.log("shop-out-email-templates.test.ts: all assertions passed");
