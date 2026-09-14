/** Platform-neutral deployment identity used by production health checks. */
export type DeploymentPlatform = "vercel" | "cloudflare" | "unknown";

export function deploymentPlatform(): DeploymentPlatform {
  if (process.env.VERCEL) return "vercel";
  if ((process.env.DEPLOY_PLATFORM || "").trim().toLowerCase() === "cloudflare") {
    return "cloudflare";
  }
  return "unknown";
}

export function isProductionRuntime(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    process.env.DEPLOY_ENV === "production"
  );
}

export function deploymentGitRef(): string | undefined {
  return process.env.VERCEL_GIT_COMMIT_REF || process.env.DEPLOY_GIT_REF;
}

export function deploymentGitSha(): string | undefined {
  return process.env.VERCEL_GIT_COMMIT_SHA || process.env.DEPLOY_GIT_SHA;
}

export function deploymentIsDirty(): boolean {
  return process.env.VERCEL_GIT_DIRTY === "true" || process.env.DEPLOY_GIT_DIRTY === "true";
}
