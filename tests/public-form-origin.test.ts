import assert from "node:assert/strict";
import { publicFormOrigin } from "../lib/forms/public-origin";

const previous = process.env.SUNBIZ_PUBLIC_FORM_ORIGIN;
const previousOasis = process.env.OASIS_PUBLIC_ORIGIN;
const previousPublicApp = process.env.PUBLIC_APP_URL;

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
  assert.equal(
    publicFormOrigin({ tenantSlug: "oasis-ai-cc", requestOrigin: "http://localhost:3100" }),
    "http://localhost:3100",
    "local form links must remain on the local development server",
  );
  process.env.OASIS_PUBLIC_ORIGIN = "https://forms.example";
  process.env.PUBLIC_APP_URL = "https://dashboard.example";
  assert.equal(
    publicFormOrigin({ tenantSlug: "oasis-ai-cc" }),
    "https://forms.example",
    "the form-specific origin must win over the generic dashboard origin",
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
  if (previousOasis === undefined) delete process.env.OASIS_PUBLIC_ORIGIN;
  else process.env.OASIS_PUBLIC_ORIGIN = previousOasis;
  if (previousPublicApp === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = previousPublicApp;
}

console.log("public form origin tests passed");
