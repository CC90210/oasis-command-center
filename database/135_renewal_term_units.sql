-- Allow Sunbiz renewal terms to be entered in months, weeks, or days while
-- preserving every existing month-based funded deal. Legacy rows continue to
-- read term_months as months; avoiding a bulk backfill keeps this migration
-- additive and safe to apply while the app is live.

alter table public.funded_deals
  add column if not exists term_value integer,
  add column if not exists term_unit text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'funded_deals_term_unit_check'
  ) then
    alter table public.funded_deals
      add constraint funded_deals_term_unit_check check (
        (term_value is null and term_unit is null)
        or (term_unit = 'months' and term_value between 1 and 60)
        or (term_unit = 'weeks' and term_value between 1 and 260)
        or (term_unit = 'days' and term_value between 1 and 1825)
      );
  end if;
end
$$;

comment on column public.funded_deals.term_value is
  'Operator-entered whole-number term in the unit selected by term_unit.';
comment on column public.funded_deals.term_unit is
  'Term unit: months, weeks, or days. Null means legacy term_months semantics.';
