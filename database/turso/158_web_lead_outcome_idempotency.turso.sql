-- 158 - retry-safe Web Leads call outcomes. THIS IS THE PRODUCTION DIALECT.
--
-- Nullable columns preserve every historical append-only row. New submissions
-- always provide request_id. The partial unique index is the durable race
-- winner: two concurrent requests with the same client UUID cannot both create
-- a call, and the loser resumes from the stored stage_from/stage_to decision.

alter table leadgen_call_outcomes add column request_id TEXT;
alter table leadgen_call_outcomes add column stage_from TEXT;
alter table leadgen_call_outcomes add column stage_to TEXT;
alter table leadgen_call_outcomes add column owner_user_id TEXT;

create unique index if not exists ux_leadgen_call_outcomes_tenant_request
  on leadgen_call_outcomes (tenant_id, request_id)
  where request_id is not null;
