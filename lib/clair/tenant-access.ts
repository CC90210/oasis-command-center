/** CLAIR belongs to the SunBiz funding workspace, not the OASIS CRM. */
export function clairEnabledForTenantSlug(slug: string | null | undefined): boolean {
  return slug?.trim().toLowerCase() === "sun";
}
