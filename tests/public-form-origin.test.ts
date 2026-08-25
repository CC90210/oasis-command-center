import assert from "node:assert/strict";
import { publicFormOrigin } from "../lib/forms/public-origin";

const previous = process.env.SUNBIZ_PUBLIC_FORM_ORIGIN;

try {
  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "https://apply.sunbizfunding.com";
  assert.equal(
    publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "https://oasisai.work" }),
    "https://apply.sunbizfunding.com",
  );
  assert.equal(
    publicFormOrigin({ tenantSlug: "sun", requestOrigin: "https://oasisai.work" }),
    "https://apply.sunbizfunding.com",
  );
  assert.equal(
    publicFormOrigin({ tenantSlug: "oasis-ai-cc", requestOrigin: "https://oasisai.work" }),
    "https://oasisai.work",
  );

  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "http://insecure.example";
  assert.equal(
    publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "https://oasisai.work" }),
    "https://oasisai.work",
    "an unsafe funding origin must fail closed to the proven HTTPS origin",
  );

  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "https://safe.example/hidden/path";
  assert.equal(
    publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "https://oasisai.work" }),
    "https://oasisai.work",
    "the configured value must be an origin, not a path",
  );
} finally {
  if (previous === undefined) delete process.env.SUNBIZ_PUBLIC_FORM_ORIGIN;
  else process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = previous;
}

console.log("public form origin tests passed");
