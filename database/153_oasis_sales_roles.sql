-- 153 — OASIS sales org: who a rep reports to.  [POSTGRES REFERENCE DIALECT]
--
-- NOT THE FILE THAT RUNS. Production is EMPIRE_DATA_BACKEND=turso_cloud; the
-- executable version is database/turso/153_oasis_sales_roles.turso.sql. This
-- exists so the schema stays expressible in Postgres and so the intent is
-- reviewable in the dialect the rest of database/ is written in.
--
-- Full rationale lives in the Turso companion. In brief: the sales org pays a
-- manager 20% of what OASIS retains from their team's deals, so "their team"
-- must be a fact the database knows. It is also the visibility input behind the
-- manager persona's canSeeTeamPipeline (lib/role-surfaces.ts).
--
-- WHERE THE TWO DIALECTS GENUINELY DIFFER
-- Postgres CAN express the self-reference and the tenant-mate constraint that
-- SQLite cannot, but this file deliberately does NOT add them: the executable
-- schema is the Turso one, and a constraint that exists only in the reference
-- dialect is a constraint that does not exist. Encoding a rule here that
-- production does not enforce would be worse than encoding nothing, because it
-- reads as a guarantee. Integrity stays in the application, once, for both.

begin;

alter table public.user_profiles add column if not exists manager_user_id uuid;

comment on column public.user_profiles.manager_user_id is
  'auth_user_id of this person''s sales manager. NULL = no manager. Drives the '
  'manager override (20% of OASIS retained on the team''s deals) and the '
  'manager persona''s team-scoped pipeline visibility. Must be same-tenant; '
  'enforced in the application, not here — see the Turso companion.';

create index if not exists idx_user_profiles_tenant_manager
  on public.user_profiles (tenant_id, manager_user_id);

commit;
