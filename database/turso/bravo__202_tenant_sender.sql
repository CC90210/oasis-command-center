-- bravo__202_tenant_sender.sql
--
-- Each workspace's own sending identity: the business name, legal name and
-- postal address its email goes out under, and the address it sends from
-- (email-sender-identity, 2026-10-02).
--
-- WHY. Every send path refused a client workspace before any mailbox was tried,
-- because the only answer to "which company is this mail from" was a hard-coded
-- map of OASIS's and SunBiz's tenants (lib/email/brand-for-tenant.ts). A client
-- had no way to register its own identity, and nothing stored the legal name
-- and physical postal address that CASL (s.6(2)) and CAN-SPAM require in every
-- commercial email. Decision D11 (approved with the Stage 3 plan): the postal
-- address is REQUIRED, so it is NOT NULL and non-blank here as well as in the
-- app.
--
-- ONE ROW PER WORKSPACE (tenant_id is the key). Written only by
-- POST /api/settings/sender for the signed-in owner's or admin's own workspace
-- (lib/email/tenant-sender.ts saveTenantSender), in one batch with its
-- tenant_audit_log row. OASIS's own workspaces and the retired client keep the
-- fixed identities in lib/email/brands.ts; the route refuses to write a row
-- for them, so there is never a second source of truth for those.
--
-- VERIFIED IS DECIDED LIVE, NOT STORED. from_address counts only while it is a
-- mailbox this workspace proved it controls: its Google Workspace mailbox
-- (tenant_integration_credentials service 'gws') whose last Test passed, or an
-- active member's own Google account (user_integration_credentials service
-- 'gmail_oauth'). Every read re-checks that against the live rows, and only
-- that check can make the identity usable. verified_via and verified_at record
-- what the check found when the identity was last saved, for the audit trail.
--
-- verified_via  'gws' | 'gmail_oauth' | NULL (not verified when last saved).
-- sending_domain  the domain of from_address, lower case (DKIM alignment).
--
-- CONVENTIONS (bravo__187, bravo__194): tenant_id TEXT NOT NULL and the key;
-- timestamps are ISO-8601 UTC strings written by the app; the WHERE tenant_id
-- in lib/email/tenant-sender.ts is the isolation boundary. Additive only:
-- nothing here drops or rewrites an existing object.
--
-- Not applied by the author: Bravo applies it at the merge gate. Until it is
-- applied, Settings > Brand reads "not set up yet" and a save answers that the
-- feature is not ready; nothing else changes, and no workspace can send as
-- itself until a row exists and verifies.

CREATE TABLE IF NOT EXISTS tenant_sender (
  tenant_id       TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  legal_name      TEXT NOT NULL CHECK (length(trim(legal_name)) > 0),
  postal_address  TEXT NOT NULL CHECK (length(trim(postal_address)) > 0),
  from_address    TEXT NOT NULL CHECK (instr(from_address, '@') > 1),
  reply_to        TEXT,
  sending_domain  TEXT NOT NULL CHECK (length(trim(sending_domain)) > 0),
  verified_via    TEXT CHECK (verified_via IS NULL OR verified_via IN ('gws', 'gmail_oauth')),
  verified_at     TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- An identity never moves to another workspace.
CREATE TRIGGER IF NOT EXISTS tenant_sender_tenant_immutable
BEFORE UPDATE OF tenant_id ON tenant_sender
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_sender.tenant_id is immutable');
END;
