import assert from "node:assert/strict";
import {
  publicFormOrigin,
  sunbizFormLinkForSend,
  SUNBIZ_FALLBACK_FORM_ORIGIN,
} from "../lib/forms/public-origin";
import { buildContext } from "../lib/drips/executor";

const KEYS = ["SUNBIZ_PUBLIC_FORM_ORIGIN", "OASIS_PUBLIC_ORIGIN", "NEXT_PUBLIC_SITE_URL", "PUBLIC_APP_URL", "DRIP_INTAKE_URL"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
function clearEnv(): void {
  for (const k of KEYS) delete process.env[k];
}

// The SunBiz fallback logs through console.error. Capture it so the test can
// assert the missing setting is reported, not just survived.
const logged: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};

try {
  clearEnv();
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

  // Production today: the Vercel project host, set 2026-08-25 for merchants
  // whose WiFi blocks .work. A configured SunBiz origin still wins.
  clearEnv();
  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "https://agent-dashboard-cc90210.vercel.app";
  assert.equal(
    publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "https://oasisai.work" }),
    "https://agent-dashboard-cc90210.vercel.app",
  );

  // ── THE DEFECT: SunBiz links must never land on OASIS's domain ─────────────
  // With no usable SunBiz origin, a link minted from a request on oasisai.work
  // used to be built on oasisai.work.
  clearEnv();
  assert.equal(
    publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "https://oasisai.work" }),
    SUNBIZ_FALLBACK_FORM_ORIGIN,
    "an unconfigured SunBiz link must use SunBiz's host, not the request's oasisai.work",
  );
  assert.equal(SUNBIZ_FALLBACK_FORM_ORIGIN, "https://www.sunbizfunding.com");
  assert.equal(
    publicFormOrigin({ tenantSlug: "sun", requestOrigin: "https://www.oasisai.work" }),
    SUNBIZ_FALLBACK_FORM_ORIGIN,
    "any oasisai.work host is OASIS's domain",
  );

  // The drip mint path passes no request origin and fell through to the
  // platform settings, then to a hardcoded oasisai.work.
  process.env.PUBLIC_APP_URL = "https://oasisai.work";
  process.env.NEXT_PUBLIC_SITE_URL = "https://oasisai.work";
  assert.equal(publicFormOrigin({ tenantSlug: "submissions" }), SUNBIZ_FALLBACK_FORM_ORIGIN);
  clearEnv();
  assert.equal(publicFormOrigin({ tenantSlug: "submissions" }), SUNBIZ_FALLBACK_FORM_ORIGIN);

  // OASIS's form setting is OASIS's; SunBiz does not follow it.
  process.env.OASIS_PUBLIC_ORIGIN = "https://forms.example";
  assert.equal(publicFormOrigin({ tenantSlug: "submissions" }), SUNBIZ_FALLBACK_FORM_ORIGIN);
  clearEnv();

  // A configured value that is unsafe, a path, or on OASIS's domain is refused
  // and falls back to SunBiz's host, never to oasisai.work.
  for (const bad of ["http://insecure.example", "https://safe.example/hidden/path", "https://oasisai.work"]) {
    process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = bad;
    assert.equal(
      publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "https://oasisai.work" }),
      SUNBIZ_FALLBACK_FORM_ORIGIN,
      `refused SunBiz origin ${bad} must fall back to SunBiz's host`,
    );
  }
  clearEnv();

  // A local server and a preview deployment still link to themselves, as before.
  assert.equal(
    publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "http://localhost:3100" }),
    "http://localhost:3100",
  );
  assert.equal(
    publicFormOrigin({ tenantSlug: "submissions", requestOrigin: "https://agent-dashboard-git-x-cc90210.vercel.app" }),
    "https://agent-dashboard-git-x-cc90210.vercel.app",
  );

  // The fallback is loud: it names the setting to fix.
  assert.ok(
    logged.some((line) => line.includes("SUNBIZ_PUBLIC_FORM_ORIGIN is not set")),
    "an unset SunBiz origin must be logged",
  );
  assert.ok(
    logged.some((line) => line.includes("SUNBIZ_PUBLIC_FORM_ORIGIN is on OASIS's domain")),
    "a SunBiz origin on oasisai.work must be logged as refused",
  );

  // ── OASIS links are unchanged ──────────────────────────────────────────────
  clearEnv();
  assert.equal(publicFormOrigin({ tenantSlug: "oasis-ai-cc" }), "https://oasisai.work");
  assert.equal(
    publicFormOrigin({ tenantSlug: "oasis-webdev", requestOrigin: "https://oasisai.work" }),
    "https://oasisai.work",
  );
  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "https://apply.sunbizfunding.com";
  assert.equal(
    publicFormOrigin({ tenantSlug: "oasis-ai-cc", requestOrigin: "https://oasisai.work" }),
    "https://oasisai.work",
    "the SunBiz setting must not touch OASIS links",
  );

  // ── Stored SunBiz links are rebuilt on SunBiz's origin at send time ────────
  clearEnv();
  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "https://agent-dashboard-cc90210.vercel.app";
  assert.equal(
    sunbizFormLinkForSend("https://oasisai.work/f/submissions/full-application/tok_123?rep=matt&ls=email#resume"),
    "https://agent-dashboard-cc90210.vercel.app/f/submissions/full-application/tok_123?rep=matt&ls=email#resume",
    "a link stored on oasisai.work must go out on the SunBiz origin, token and query intact",
  );
  assert.equal(
    sunbizFormLinkForSend("https://oasisai.work/f/sun/full-application/tok_9"),
    "https://agent-dashboard-cc90210.vercel.app/f/sun/full-application/tok_9",
  );
  const current = "https://agent-dashboard-cc90210.vercel.app/f/submissions/full-application/tok_7";
  assert.equal(sunbizFormLinkForSend(current), current, "a link already on the SunBiz origin is untouched");
  const foreign = "https://forms.some-lender.example/f/submissions/full-application/x?y=1";
  assert.equal(
    sunbizFormLinkForSend(foreign),
    foreign,
    "another site's link with the same path is not ours to rewrite",
  );

  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "https://apply.sunbizfunding.com";
  assert.equal(
    sunbizFormLinkForSend(current),
    "https://apply.sunbizfunding.com/f/submissions/full-application/tok_7",
    "changing the setting moves every stored link with it",
  );

  clearEnv();
  assert.equal(
    sunbizFormLinkForSend("https://oasisai.work/f/submissions/initial-lead-capture?rep=jordan"),
    "https://www.sunbizfunding.com/f/submissions/initial-lead-capture?rep=jordan",
    "with nothing configured a stored link still leaves OASIS's domain",
  );

  // Everything that is not a SunBiz form link comes back exactly as it was.
  for (const untouched of [
    "https://oasisai.work/f/oasis-ai-cc/start",
    "https://oasisai.work/f/oasis-webdev/client-onboarding/tok",
    "https://form.jotform.com/253155026259254",
    "https://oasisai.work/submissions/f",
    "",
    "not a url",
  ]) {
    assert.equal(sunbizFormLinkForSend(untouched), untouched, `must not rewrite ${JSON.stringify(untouched)}`);
  }

  // ── The drip executor sends SunBiz links on SunBiz's origin ────────────────
  // This is the path that sent 359 of 456 SunBiz sequence emails since
  // 2026-08-25 with an oasisai.work link: it rendered the stored link as-is.
  clearEnv();
  process.env.SUNBIZ_PUBLIC_FORM_ORIGIN = "https://agent-dashboard-cc90210.vercel.app";
  const appUrl = (data: Record<string, unknown>, channel: "sms" | "email") =>
    new URL((buildContext(data, channel) as { lead: { application_url: string } }).lead.application_url);

  const stored = appUrl({ application_url: "https://oasisai.work/f/submissions/full-application/tok_42" }, "email");
  assert.equal(stored.origin, "https://agent-dashboard-cc90210.vercel.app", "a stored oasisai.work link goes out on the SunBiz origin");
  assert.equal(stored.pathname, "/f/submissions/full-application/tok_42", "with the merchant's own token");

  const generic = appUrl({ rep_name: "Jordan Smith" }, "sms");
  assert.equal(generic.origin, "https://agent-dashboard-cc90210.vercel.app", "the generic intake link is SunBiz's too");
  assert.equal(generic.pathname, "/f/submissions/initial-lead-capture");
  assert.equal(generic.searchParams.get("rep"), "jordan");

  clearEnv();
  assert.equal(
    appUrl({}, "email").origin,
    SUNBIZ_FALLBACK_FORM_ORIGIN,
    "with nothing configured the intake link is on SunBiz's host, not the old hardcoded oasisai.work",
  );
  process.env.DRIP_INTAKE_URL = "https://www.sunbizfunding.com/start";
  const explicit = appUrl({ rep_name: "Matt" }, "email");
  assert.equal(`${explicit.origin}${explicit.pathname}`, "https://www.sunbizfunding.com/start", "an explicit DRIP_INTAKE_URL still wins");
  assert.equal(explicit.searchParams.get("rep"), "matt");
  clearEnv();

  const oasisLink = appUrl({ application_url: "https://oasisai.work/f/oasis-webdev/client-onboarding/tok" }, "email");
  assert.equal(oasisLink.origin, "https://oasisai.work", "an OASIS lead's link is left alone");
  assert.equal(oasisLink.pathname, "/f/oasis-webdev/client-onboarding/tok");
} finally {
  console.error = originalError;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

console.log("public form origin tests passed");
