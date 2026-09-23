import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deploymentRuntimeLabel,
  deploymentSurface,
  externalTenantSurfacesBlocked,
} from "../lib/deployment-surface";

const saved = {
  DEPLOY_SURFACE: process.env.DEPLOY_SURFACE,
  DEPLOY_PLATFORM: process.env.DEPLOY_PLATFORM,
  DEPLOY_ENV: process.env.DEPLOY_ENV,
  VERCEL: process.env.VERCEL,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

try {
  delete process.env.DEPLOY_SURFACE;
  delete process.env.DEPLOY_PLATFORM;
  delete process.env.DEPLOY_ENV;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  assert.equal(deploymentSurface(), "unclassified");
  assert.equal(externalTenantSurfacesBlocked(), false, "local development keeps shared-code testing available");
  assert.equal(deploymentRuntimeLabel(), "hosted runtime");

  process.env.DEPLOY_PLATFORM = "cloudflare";
  assert.equal(deploymentRuntimeLabel(), "Cloudflare runtime");
  delete process.env.DEPLOY_PLATFORM;

  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "production";
  assert.equal(deploymentRuntimeLabel(), "Vercel runtime");
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;

  process.env.DEPLOY_SURFACE = "oasis";
  assert.equal(externalTenantSurfacesBlocked(), true);

  process.env.DEPLOY_SURFACE = "client";
  assert.equal(externalTenantSurfacesBlocked(), false);

  delete process.env.DEPLOY_SURFACE;
  process.env.DEPLOY_ENV = "production";
  assert.equal(
    externalTenantSurfacesBlocked(),
    false,
    "the transitional shared Vercel deployment must rely on exact tenant authorization",
  );

  const breeze = readFileSync("app/api/automations/breeze-deals/route.ts", "utf8");
  assert.ok(
    breeze.indexOf("externalTenantSurfacesBlocked()") < breeze.indexOf("getSessionUser()"),
    "the tenant-only deal endpoint must 404 before session or database resolution",
  );
  assert.doesNotMatch(breeze, /isOperatorEmail/);
  assert.doesNotMatch(breeze, /\.eq\("slug",\s*"submissions"\)/);
  assert.match(breeze, /const dealsTenantId = sessionTenantId/);

  const control = readFileSync(
    "app/api/automations/background-workers/control/route.ts",
    "utf8",
  );
  assert.ok(
    control.indexOf("externalTenantSurfacesBlocked()") <
      control.indexOf("const auth = await authorizeBridgeRequest()"),
    "the remote worker-control endpoint must 404 before bridge authorization or database work",
  );
  assert.match(control, /auth\.tenantSlug !== "submissions"[\s\S]*?status: 404/);

  const workers = readFileSync("app/api/automations/background-workers/route.ts", "utf8");
  assert.doesNotMatch(
    workers,
    /^import .*SUNBIZ_WORKERS/m,
    "the OASIS worker route must not eagerly load another tenant's inventory",
  );
  assert.match(workers, /oasisOnlyDeployment[\s\S]*?isOasisSurfaceTenant\(tenantSlug\)[\s\S]*?status: 404/);
  assert.match(workers, /await import\("@\/lib\/automations\/sunbiz-workers"\)/);

  const ui = readFileSync("components/automations/AutomationsContent.tsx", "utf8");
  assert.match(ui, /!externalTenantSurfacesBlocked\(\) && tenantSlug === "sun"/);

  const workflow = readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");
  assert.match(workflow, /--var DEPLOY_PLATFORM:cloudflare/);
  assert.match(workflow, /--var DEPLOY_SURFACE:oasis/);

  console.log("oasis deployment boundary ok");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
