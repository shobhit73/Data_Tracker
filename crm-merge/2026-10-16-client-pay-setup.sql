-- Company-level payroll setup per Amazon DSP: earnings, deductions,
-- contributions, federal and state tax settings, from prod. Read-only
-- reporting table: the prod-refresh payroll_setup job replaces it in full
-- (service role); the app only selects. State tax account numbers arrive
-- already masked to their last four characters.
-- Run once in the Supabase SQL editor (CRM project). Idempotent.
create table if not exists client_pay_setup (
  id             bigint generated always as identity primary key,
  dsp_short_code text,
  company_name   text,
  category       text,          -- Earning | Deduction | Contribution | Federal tax | State tax
  name           text,
  code           text,
  active         boolean not null default true,   -- false = discarded in Uzio
  settings       jsonb not null default '{}'::jsonb,
  updated_date   date,
  checked_date   date
);
create index if not exists client_pay_setup_code on client_pay_setup (dsp_short_code);
alter table client_pay_setup enable row level security;
drop policy if exists pay_setup_read on client_pay_setup;
create policy pay_setup_read on client_pay_setup for select to authenticated using (true);
grant select on client_pay_setup to authenticated;
grant all on client_pay_setup to service_role;
