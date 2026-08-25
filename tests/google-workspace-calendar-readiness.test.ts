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
    oauthCallback.includes('.eq("tenant_id", tenantId)') &&
    oauthCallback.includes('.eq("auth_user_id", user.id)'),
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
