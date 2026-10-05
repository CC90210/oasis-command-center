export type DeploymentSurface = "oasis" | "client" | "unclassified";
export type DeploymentRuntime = "cloudflare" | "vercel" | "hosted";

/**
 * Runtime boundary between the OASIS portal and separately deployed tenant
 * portals. The legacy Vercel deployment still hosts multiple tenant surfaces,
 * so only an explicitly OASIS-scoped deployment activates this physical fence.
 * Tenant/session authorization remains mandatory on the shared deployment.
 */
export function deploymentSurface(): DeploymentSurface {
  const configured = (process.env.DEPLOY_SURFACE || "").trim().toLowerCase();
  if (configured === "oasis" || configured === "client") return configured;
  return "unclassified";
}

export function externalTenantSurfacesBlocked(): boolean {
  return deploymentSurface() === "oasis";
}

/**
 * Human-readable host for diagnostics and model prompts. DEPLOY_PLATFORM is
 * explicitly set by the Cloudflare workflow; Vercel supplies VERCEL/VERCEL_ENV
 * itself. Unknown and local/test environments stay provider-neutral.
 */
export function deploymentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentRuntime {
  if ((env.DEPLOY_PLATFORM || "").trim().toLowerCase() === "cloudflare") return "cloudflare";
  if (env.VERCEL === "1" || Boolean(env.VERCEL_ENV)) return "vercel";
  return "hosted";
}

export function deploymentRuntimeLabel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runtime = deploymentRuntime(env);
  if (runtime === "cloudflare") return "Cloudflare runtime";
  if (runtime === "vercel") return "Vercel runtime";
  return "hosted runtime";
}
