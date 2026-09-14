export type DeploymentSurface = "oasis" | "client" | "unclassified";

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
