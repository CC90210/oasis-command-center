import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const oauthStart = read("app/api/auth/google-oauth/start/route.ts");
const oauthCallback = read("app/api/auth/google-oauth/callback/route.ts");
const personalStatus = read("app/api/integrations/personal/status/route.ts");
const teamMembers = read("app/api/team/members/route.ts");
const panel = read("components/settings/PersonalIntegrationsPanel.tsx");

const workScopes = oauthStart.match(
  /const WORK_OAUTH_SCOPES = \[([\s\S]*?)\]\.join\(" "\);/u,
)?.[1];
const personalScopes = oauthStart.match(
  /const PERSONAL_OAUTH_SCOPES = \[([\s\S]*?)\]\.join\(" "\);/u,
)?.[1];

assert(workScopes, "work Google OAuth scopes must be declared separately");
assert(personalScopes, "personal Gmail OAuth scopes must be declared separately");
assert(
  workScopes.includes("gmail.send") &&
    workScopes.includes("gmail.readonly") &&
    workScopes.includes("calendar.events"),
  "the work Google Workspace connection must grant Gmail send/read and Calendar event access",
);
assert(
  personalScopes.includes("gmail.readonly") &&
    !personalScopes.includes("gmail.send") &&
    !personalScopes.includes("calendar.events"),
  "the optional personal mailbox must remain Gmail read-only",
);
assert(
  oauthStart.includes('mailbox === "personal" ? PERSONAL_OAUTH_SCOPES : WORK_OAUTH_SCOPES'),
  "the consent URL must choose scopes by mailbox instead of over-granting personal Gmail",
);
assert(
  oauthStart.includes('authUrl.searchParams.set("include_granted_scopes", "true")'),
  "Google OAuth must retain previously granted permissions during the one-time reconnect",
);

assert(
  oauthCallback.includes("CALENDAR_EVENTS_SCOPE") &&
    oauthCallback.includes("calendar_events_scope_not_granted"),
  "the callback must fail closed when the work account omits Calendar event permission",
);
assert(
  oauthCallback.includes('service === "gmail_oauth"') &&
    oauthCallback.includes("GMAIL_SEND_SCOPE") &&
    oauthCallback.includes("GMAIL_READONLY_SCOPE"),
  "the callback must keep work and personal mailbox requirements distinct",
);
assert(
  oauthCallback.includes("google_account_must_match_profile_email") &&
    oauthCallback.includes("resolveActiveProfileForUser(user)") &&
    oauthCallback.includes("profile.profile?.tenant_id !== tenantId") &&
    oauthCallback.includes("profile.profile?.email"),
  "work OAuth must reject a personal or cross-profile Google identity before storing its tokens",
);

for (const [surface, source] of [
  ["personal integration status", personalStatus],
  ["team host roster", teamMembers],
] as const) {
  assert(source.includes("calendar_connected"), `${surface} must expose Calendar readiness`);
  assert(
    source.includes("calendar_reconnect_required"),
    `${surface} must identify legacy work connections that need one reconnect`,
  );
  assert(
    source.includes("calendar_identity_mismatch"),
    `${surface} must fail closed when a host connected the wrong Google account`,
  );
  assert.equal(
    source.includes("...bundle"),
    false,
    `${surface} must never spread decrypted OAuth credentials into a response`,
  );
}

assert(
  panel.includes("Google Workspace (Gmail + Calendar)"),
  "Settings must name the work connection by both capabilities",
);
assert(
  panel.includes("Reconnect once"),
  "Settings must give legacy hosts a precise one-time reconnect instruction",
);
assert(
  panel.includes("Connect personal Gmail (monitor only)"),
  "Settings must make the narrower personal-mailbox permission explicit",
);
assert(
  panel.includes("Wrong Google account") && panel.includes("expected_work_email"),
  "Settings must identify the exact work-identity mismatch instead of sending as a personal Gmail account",
);
assert(
  panel.includes('oauthMailbox === "personal"'),
  "the OAuth success banner must not claim Calendar access for a personal read-only mailbox",
);

console.log("google-workspace-calendar-readiness: all assertions passed");

// ---------------------------------------------------------------------------
// EVERY DECLARED CALENDAR ERROR CODE MUST HAVE A HUMAN MESSAGE.
//
// Added 2026-08-26. Five of the twelve codes in GoogleCalendarErrorCode had no
// entry in LeadLifecycleActions' readableError map, so the RAW CODE reached the
// rep's screen mid-handoff. The operator reported it as "it says invalid token
// or something" -- that was `token_refresh_failed` falling through the map onto
// a sales rep who had just filled in a whole booking form.
//
// This is a source check because that is where the gap lives: the union and the
// map are in different files and nothing made them agree.
{
  const calSrc = readFileSync(`${process.cwd()}/lib/integrations/google-calendar.ts`, "utf8");
  const uiSrc = readFileSync(`${process.cwd()}/app/pipeline/[id]/LeadLifecycleActions.tsx`, "utf8");

  const union = calSrc.match(/export type GoogleCalendarErrorCode =([\s\S]*?);/);
  assert.ok(union, "could not find the GoogleCalendarErrorCode union -- this check must not silently pass");
  const codes = [...union![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 10, `expected the full error union, parsed only ${codes.length} codes`);

  const missing = codes.filter((c) => !new RegExp(`(^|\\s)${c}:`, "m").test(uiSrc));
  assert.deepEqual(
    missing,
    [],
    `these calendar error codes have no human-readable message and would reach a sales rep as a raw code: ${missing.join(", ")}`,
  );
}

console.log("google-workspace-calendar-readiness error-map coverage ok");
