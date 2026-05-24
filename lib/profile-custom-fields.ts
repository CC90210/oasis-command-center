/**
 * Canonical keys that live inside `user_profiles.custom_fields` (JSONB).
 *
 * `custom_fields` is the shared free-form blob the welcome wizard, the
 * settings page, and any future per-user prefs surface write to without
 * needing a dedicated SQL column. The problem with a blob is silent
 * collision — two features both write `theme` and clobber each other
 * with no compile-time warning.
 *
 * This file is the single source of truth. Every reader / writer of
 * custom_fields imports `PROFILE_CUSTOM_FIELD_KEYS.X` instead of using
 * a string literal. Adding a new key is a one-line change here, and
 * grep'ing for the key constant shows every site that touches it.
 *
 * Schema-wise nothing in Supabase enforces these — Postgres just sees
 * a jsonb. The enforcement is convention + lint via `git grep` for
 * stray string literals when a key is renamed.
 */
export const PROFILE_CUSTOM_FIELD_KEYS = {
  /** Operator-editable Markdown scratchpad of evergreen facts (calendar
   *  link, signature, business name, common asks). Injected verbatim
   *  into every cloud chat as the OPERATOR KNOWN FACTS block. Edited
   *  via Settings → "Known facts about you" (KnownFactsEditor.tsx) and
   *  read at app/api/chat/route.ts ~line 432. */
  QUICK_FACTS: "quick_facts",
  /** Wizard-saved operator timezone (IANA). */
  TIMEZONE: "timezone",
  /** Wizard-saved daily briefing channel (email/sms/slack/none). */
  BRIEFING_CHANNEL: "briefing_channel",
  /** Profile photo URL set during onboarding. */
  PHOTO_URL: "photo_url",
} as const;

export type ProfileCustomFieldKey =
  (typeof PROFILE_CUSTOM_FIELD_KEYS)[keyof typeof PROFILE_CUSTOM_FIELD_KEYS];

/**
 * Type-safe getter for a string-valued custom field. Returns `null`
 * when the field is missing, empty, or not a string. Callers that need
 * a different shape (number, object) should read the blob directly and
 * narrow themselves.
 */
export function getCustomFieldString(
  customFields: Record<string, unknown> | null | undefined,
  key: ProfileCustomFieldKey,
): string | null {
  if (!customFields || typeof customFields !== "object") return null;
  const v = (customFields as Record<string, unknown>)[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
