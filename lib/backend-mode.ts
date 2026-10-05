/**
 * Canonical backend-mode parser.
 *
 * Turso is the post-cutover default. Supabase is reachable only when an
 * operator deliberately selects the clearly named `supabase_legacy` rollback
 * mode. Missing or misspelled flags must never turn into an implicit legacy
 * write path.
 */

export const LEGACY_SUPABASE_MODE = "supabase_legacy" as const;

export type DataBackendMode = "turso" | typeof LEGACY_SUPABASE_MODE;
export type AuthBackendMode = "turso" | typeof LEGACY_SUPABASE_MODE;

type EnvLike = Readonly<Record<string, string | undefined>>;

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function getDataBackendMode(env: EnvLike = process.env): DataBackendMode {
  const configured = normalized(env.EMPIRE_DATA_BACKEND);
  switch (configured) {
    case "":
    case "turso":
    case "turso_cloud":
    case "turso_local":
      return "turso";
    case LEGACY_SUPABASE_MODE:
      return LEGACY_SUPABASE_MODE;
    default:
      throw new Error(
        `Unsupported EMPIRE_DATA_BACKEND=${JSON.stringify(configured)}. ` +
          `Turso is the default; the only Supabase rollback value is ` +
          `${LEGACY_SUPABASE_MODE}.`,
      );
  }
}

export function getAuthBackendMode(env: EnvLike = process.env): AuthBackendMode {
  const configured = normalized(env.EMPIRE_AUTH_BACKEND);
  switch (configured) {
    case "":
    case "turso":
      return "turso";
    case LEGACY_SUPABASE_MODE:
      return LEGACY_SUPABASE_MODE;
    default:
      throw new Error(
        `Unsupported EMPIRE_AUTH_BACKEND=${JSON.stringify(configured)}. ` +
          `Turso is the default; the only Supabase rollback value is ` +
          `${LEGACY_SUPABASE_MODE}.`,
      );
  }
}
