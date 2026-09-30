/**
 * lib/playbook/security-model.ts - OASIS's security model, as the words an
 * operator may repeat to a client. ONE source: /playbook/security renders these
 * sections, and the Business documentation hub's "Security model" document
 * (lib/playbook/catalog.ts, app_live) renders the same markdown, so the page,
 * its Copy and its Download can never disagree.
 *
 * WHY IT WAS REWRITTEN (2026-09-30, audit playbook-security-false-claims). The
 * page was a 2026-05 mirror of a harness doc from the previous stack: it said
 * isolation was enforced by per-row database policies, that the encryption key
 * lived on the old hosting provider, and it listed verification commands that
 * no longer run (one would have written a row to the retired database). OASIS
 * runs on Turso (libSQL) and Cloudflare Workers. Turso has no per-row
 * policies, so isolation is the application's tenant_id filter, the same fact
 * lib/legal/constants.ts states for the public legal pages.
 *
 * Every statement below was checked against the code on SECURITY_MODEL_VERIFIED
 * (file named inline). tests/playbook-copy-drift.test.ts bans the retired
 * stack's names from this file, the Playbook pages and the Playbook markdown.
 * If the code changes, change this file in the same commit and move the date.
 */

export const SECURITY_MODEL_VERIFIED = "2026-09-30";

export type SecuritySection = { key: string; title: string; subtitle: string; body: string };

export const SECURITY_SUMMARY =
  "Every workspace shares one application on Cloudflare Workers and one Turso (libSQL) database stored in the " +
  "United States. Isolation between workspaces is enforced by the application: every tenant-scoped table carries a " +
  "tenant_id, and every query filters on the workspace taken from the signed-in session. The database has no " +
  "per-row policies of its own, so never describe the isolation as database-enforced. Deployment secrets are " +
  "Cloudflare Worker secrets. AI provider keys a workspace connects are encrypted with AES-256-GCM before they are " +
  "stored. Desktop bridge tokens are stored only as SHA-256 hashes, and a re-paired machine rotates its token " +
  "instead of adding a second pairing.";

export const SECURITY_SECTIONS: readonly SecuritySection[] = [
  {
    key: "isolation",
    title: "Tenant isolation",
    subtitle: "One application, one database, application-level isolation.",
    body: [
      "- Every workspace uses the same application (Cloudflare Workers, `wrangler.jsonc`) and the same Turso (libSQL) database, stored in the United States.",
      "- Every tenant-scoped table carries a `tenant_id` column. Application queries filter on it and every write stamps it. The workspace comes from the signed-in session or from the record being acted on, never from what a request body says about itself.",
      "- The database has no per-row policies of its own. The isolation is enforced by the application's queries. Say \"application-level isolation\"; never say the database enforces it.",
      "- Automated tests pin the boundary: a member of another workspace gets a 404 on every OASIS-only page (`tests/f0-containment.test.ts`), and a client never reads another client's tickets or projects (`npm run test:delivery`).",
    ].join("\n"),
  },
  {
    key: "sessions",
    title: "Sign-in and sessions",
    subtitle: "bcrypt passwords, HMAC-signed session cookies with a version.",
    body: [
      "- Passwords are verified against bcrypt hashes (`lib/turso-auth.ts`).",
      "- A session is an HttpOnly cookie signed with HMAC-SHA256 using `AUTH_SESSION_SECRET`. Rotating that secret signs everyone out.",
      "- Each session carries the account's session version. Bumping an account's stored session version invalidates every existing session for that account.",
    ].join("\n"),
  },
  {
    key: "secrets",
    title: "Secrets and encryption at rest",
    subtitle: "Worker secrets for the deployment; AES-256-GCM for workspace keys.",
    body: [
      "- Deployment secrets (the encryption key, the session key, provider keys) are Cloudflare Worker secrets. They are not in the code or the repository.",
      "- AI provider keys a workspace connects are encrypted before storage (`lib/field-encryption.ts`): AES-256-GCM, which detects tampering, with the key derived by scrypt from `BRAVO_FIELD_ENCRYPTION_KEY` and a fixed deploy-wide salt. They are stored as `base64(iv).base64(authTag).base64(ciphertext)` in `agent_model_config.encrypted_api_key`.",
      "- Known limit: one encryption key serves every workspace, with no key id and no rotation. Rotating `BRAVO_FIELD_ENCRYPTION_KEY` today would make every stored key unreadable.",
    ].join("\n"),
  },
  {
    key: "files",
    title: "Files",
    subtitle: "Uploads live in Cloudflare R2.",
    body: "- Uploaded documents and attachments are stored in Cloudflare R2 (`lib/r2-storage.ts`), the same processor the privacy policy lists.",
  },
  {
    key: "bridge",
    title: "Desktop bridge",
    subtitle: "Hashed tokens, one live pairing per machine, constant-time secret checks.",
    body: [
      "- Each paired machine gets an `oab_` bearer token made of 32 random bytes. Only its SHA-256 hash is stored (`bridge_pairings.bridge_token_hash`); the plaintext is returned once to the daemon, which keeps it in `~/.oasis/bridge_token`.",
      "- Re-pairing the same machine rotates the token on the existing row. A partial unique index on `(tenant_id, machine_fingerprint) WHERE revoked_at IS NULL` allows one live pairing per machine, and the pair route treats a unique-constraint conflict as a rotation (`app/api/auth/pair/route.ts`).",
      "- Revoking a pairing sets `revoked_at`; `/api/bridge/ping` answers 403 from then on.",
      "- A daemon can pair itself with the `x-oasis-profile-id` and `x-oasis-secret` headers. The secret is stored as a SHA-256 hash and compared with `timingSafeEqual`. It is issued from the harness with `python scripts/integrations/n8n_webhook_secret.py issue --profile-email <email>`.",
      "- Installing the bridge on a client's computer is paused: the install scripts are operator-only.",
    ].join("\n"),
  },
  {
    key: "limits",
    title: "What we do not claim",
    subtitle: "Say these plainly when a client asks.",
    body: [
      "- **No certification.** OASIS holds no SOC 2 or ISO 27001 certification.",
      "- **A compromised computer is out of scope.** Whoever controls the operator's own computer can read `~/.oasis/bridge_token` and the harness's local secrets. Disk encryption and the computer's own login are the defence.",
      "- **One region.** Every workspace is stored in the United States. A client that needs its own database or another region needs a separate engineering project; do not promise it.",
    ].join("\n"),
  },
];

export const SECURITY_VERIFY_COMMANDS = [
  "# The database connection and its tenant-scoped tables (harness, read-only)",
  "python scripts/integrations/turso_tool.py status",
  "python scripts/integrations/turso_tool.py tables",
  "",
  "# Constant-time secret comparison in the pair route (this repo)",
  "grep -n \"timingSafeEqual\" app/api/auth/pair/route.ts",
  "",
  "# The containment tests: other workspaces get a 404 on OASIS pages (this repo)",
  "npm run test:os",
].join("\n");

/** The whole model as one markdown document (the hub's Copy and Download). */
export function securityModelMarkdown(): string {
  const parts = [
    "# Security model",
    "",
    `Verified against the code on ${SECURITY_MODEL_VERIFIED}. These are the statements an operator may repeat to a client. If a question is not answered here, say you will check; never fill the gap.`,
    "",
    "## In one paragraph",
    "",
    SECURITY_SUMMARY,
  ];
  for (const s of SECURITY_SECTIONS) parts.push("", `## ${s.title}`, "", s.body);
  parts.push("", "## Verify it yourself", "", "```", SECURITY_VERIFY_COMMANDS, "```", "");
  return parts.join("\n");
}
