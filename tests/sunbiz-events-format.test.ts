import assert from "node:assert/strict";
import { maskTaxId, buildSunbizEventMessage } from "../lib/notify/sunbiz-events-format";

// maskTaxId — last 4 only
assert.equal(maskTaxId("12-3456789"), "••••6789");
assert.equal(maskTaxId("123456789"), "••••6789");
assert.equal(maskTaxId("12"), "—");
assert.equal(maskTaxId(null), "—");

// first_application — 🟢, the 4 contact fields, missing → "—"
const first = buildSunbizEventMessage("first_application", {
  contact_name: "Jane Doe",
  business_name: "Acme Garage",
  phone: "754-212-7833",
});
assert.ok(first.includes("🟢"), "green marker");
assert.ok(first.includes("FIRST APPLICATION SUBMITTED"));
assert.ok(first.includes("Jane Doe") && first.includes("Acme Garage"));
assert.ok(first.includes("Email: —"), "missing email renders as dash");

// second_application — masks the tax id, never leaks it
const second = buildSunbizEventMessage("second_application", {
  contact_name: "Jane",
  business_ein: "98-7654321",
  monthly_revenue: "$42,000",
});
assert.ok(second.includes("🟡"));
assert.ok(second.includes("••••4321"), "tax id masked to last 4");
assert.ok(!second.includes("98-7654321") && !second.includes("987654321"), "full tax id never present");

// HTML-escape untrusted merchant text (prevent Telegram HTML injection)
const xss = buildSunbizEventMessage("first_application", { contact_name: "<b>x</b>&y" });
assert.ok(xss.includes("&lt;b&gt;x&lt;/b&gt;&amp;y"), "merchant text is HTML-escaped");

// bank_statements — 🔵 + file count
const bank = buildSunbizEventMessage("bank_statements", { business_name: "Acme", file_count: 6 });
assert.ok(bank.includes("🔵") && bank.includes("Files: 6"));

console.log("sunbiz-events-format tests passed");
