import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientIpFromHeaders, publicAppBaseUrl } from "../lib/api-helpers";

const headers = (values: Record<string, string>) => ({
  get(name: string) {
    return values[name.toLowerCase()] ?? null;
  },
});

const savedVercel = process.env.VERCEL;
const savedPlatform = process.env.DEPLOY_PLATFORM;
const savedNodeEnv = process.env.NODE_ENV;
const savedDashboard = process.env.BRAVO_DASHBOARD_URL;
const savedPublic = process.env.PUBLIC_APP_URL;
try {
  delete process.env.VERCEL;
  process.env.DEPLOY_PLATFORM = "cloudflare";
  assert.equal(
    clientIpFromHeaders(
      headers({
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "198.51.100.99, 192.0.2.4",
      }),
    ),
    "203.0.113.10",
    "Cloudflare's edge-stamped address must outrank spoofable XFF",
  );

  delete process.env.DEPLOY_PLATFORM;
  process.env.NODE_ENV = "production";
  assert.equal(
    clientIpFromHeaders(headers({ "cf-connecting-ip": "203.0.113.11" })),
    "unknown",
    "an unknown production host must not trust a caller-supplied Cloudflare header",
  );

  process.env.VERCEL = "1";
  assert.equal(
    clientIpFromHeaders(
      headers({
        "x-vercel-forwarded-for": "203.0.113.20",
        "cf-connecting-ip": "198.51.100.88",
      }),
    ),
    "203.0.113.20",
    "the direct Vercel host must trust its own edge header first",
  );

  delete process.env.BRAVO_DASHBOARD_URL;
  process.env.PUBLIC_APP_URL = "https://oasisai.work/";
  assert.equal(publicAppBaseUrl(), "https://oasisai.work");
  process.env.PUBLIC_APP_URL = "http://attacker.example";
  assert.equal(
    publicAppBaseUrl(),
    "https://oasisai.work",
    "pairing never derives an external URL from an insecure or request-controlled origin",
  );

  const pair = readFileSync("app/api/auth/pair/route.ts", "utf8");
  const redeem = readFileSync("app/api/auth/pair-code/redeem/route.ts", "utf8");
  for (const source of [pair, redeem]) {
    assert.match(source, /publicAppBaseUrl\(\)/);
    assert.doesNotMatch(source, /new URL\(req\.url\)\.origin/);
    assert.doesNotMatch(source, /agent-dashboard-cc90210\.vercel\.app/);
  }

  const authRoutes = [
    "app/auth/turso-session/route.ts",
    "app/api/auth/turso-login/route.ts",
    "app/api/auth/turso-reset-confirm/route.ts",
    "app/api/auth/turso-reset-request/route.ts",
    "app/api/auth/turso-signup/route.ts",
  ];
  for (const path of authRoutes) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /getClientIp\(req\)/, `${path} must use the platform-aware IP helper`);
    assert.doesNotMatch(source, /headers\.get\("x-forwarded-for"\)/);
  }

  const signPage = readFileSync("app/sign/[token]/page.tsx", "utf8");
  assert.match(signPage, /clientIpFromHeaders\(h\)/);

  const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
    vars?: Record<string, string>;
  };
  assert.equal(wrangler.vars?.DEPLOY_ENV, "production");
  assert.equal(wrangler.vars?.DEPLOY_PLATFORM, "cloudflare");
  assert.equal(wrangler.vars?.DEPLOY_SURFACE, "oasis");

  const health = readFileSync("app/api/health/route.ts", "utf8");
  assert.match(health, /deploymentGitSha\(\)/);
  assert.match(health, /deploymentGitRef\(\)/);

  console.log("cloudflare runtime parity ok");
} finally {
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;
  if (savedPlatform === undefined) delete process.env.DEPLOY_PLATFORM;
  else process.env.DEPLOY_PLATFORM = savedPlatform;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedDashboard === undefined) delete process.env.BRAVO_DASHBOARD_URL;
  else process.env.BRAVO_DASHBOARD_URL = savedDashboard;
  if (savedPublic === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = savedPublic;
}
