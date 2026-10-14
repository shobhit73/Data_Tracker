-- Earned-wage-access providers per live DSP (DailyPay, ZayZoon, PayActiv),
-- from prod. Read-only reporting table: the prod-refresh ewa_status job
-- replaces it in full (service role); the app only selects.
-- Run once in the Supabase SQL editor (CRM project). Idempotent.
create table if not exists client_ewa (
  id                 bigint generated always as identity primary key,
  dsp_short_code     text,
  company_name       text,
  live_status        text,
  dailypay           boolean not null default false,
  dailypay_start     date,
  zayzoon            boolean not null default false,
  zayzoon_start      date,
  payactiv           boolean not null default false,
  payactiv_schedule  text,
  payactiv_start     date,
  company_identifier text,
  checked_date       date
);
alter table client_ewa enable row level security;
drop policy if exists ewa_read on client_ewa;
create policy ewa_read on client_ewa for select to authenticated using (true);
grant select on client_ewa to authenticated;
grant all on client_ewa to service_role;
