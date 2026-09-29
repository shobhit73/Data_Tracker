-- Phase 2 of the platform merge: the DSP Ops dashboard's data views move into
-- the CRM. Five read-only tables, filled by a push script from Shobhit's side
-- (service key), read by the app under login. Run in the Supabase SQL editor.
-- Destined for the CRM repo as scripts/migrations/2026-09-29-phase2-data-views.sql.
--
-- App writes are impossible by design: RLS is enabled with a SELECT policy
-- only, and the loader (service role) bypasses RLS. Each refresh replaces the
-- whole table, so there are no upsert keys — the identity id exists so the
-- loader can say "delete everything" with a uniform filter (id > 0).

-- Onboarding-API run history, one row per (client, module): which of the nine
-- onboarding APIs have ever been run for which client, and how the last runs went.
create table if not exists api_activity_runs (
  id             bigint generated always as identity primary key,
  fein           text,
  client_name    text,
  vendor         text,
  module_key     text,
  last_run_date  date,
  run_by         text,
  run_status     text,          -- ok | last_failed | never_ok | null
  last_total     integer,
  last_success   integer,
  last_failed    integer,
  last_ok_date   date,
  last_ok_by     text,
  last_ok_total  integer,
  last_ok_success integer,
  updated_at     timestamptz
);

-- Payroll handover health: for each migrated client, does prior-payroll data
-- plus Uzio's own runs cover the pay periods without a gap.
create table if not exists payroll_health (
  id              bigint generated always as identity primary key,
  dsp_short_code  text,
  fein            text,
  company_name    text,
  previous_system text,
  target_from     date,
  target_to       date,
  prior_from      date,
  prior_to        date,
  prior_rows      integer,
  normal_from     date,
  normal_to       date,
  normal_rows     integer,
  handover_gap    boolean,
  gap_days        integer,
  gap_ranges      text,
  status          text,          -- Covered | Gap | Handover gap | New to platform
  checked_date    date,
  updated_at      timestamptz
);

-- Employee data coverage per client, straight from prod: how many employees
-- have a payment method, emergency contact, licence, worker-comp code.
create table if not exists client_data_coverage (
  id                           bigint generated always as identity primary key,
  dsp_short_code               text,
  fein                         text,
  company_name                 text,
  total_employees              integer,
  active_employees             integer,
  total_with_payment_method    integer,
  active_with_payment_method   integer,
  total_with_emergency_contact integer,
  active_with_emergency_contact integer,
  total_with_licence           integer,
  active_with_licence          integer,
  total_with_worker_comp       integer,
  active_with_worker_comp      integer,
  worker_comp_codes            text,
  checked_date                 date,
  updated_at                   timestamptz
);

-- Document-transfer runs (from the transfer mails): per client, how the bulk
-- document load went and how the failures broke down.
create table if not exists document_transfer (
  id                      bigint generated always as identity primary key,
  client_name             text,
  status                  text,   -- Complete | Completed with issues | In progress | Blocked | Nothing to transfer
  transfer_date           date,
  total_docs              integer,
  failed_docs             integer,
  failed_resolved         integer,
  employees_skipped       integer,
  fail_filename_format    integer,
  fail_employee_not_found integer,
  fail_unsupported_type   integer,
  fail_size_limit         integer,
  jira_id                 text,
  drive_folder_url        text,
  notes                   text,
  updated_at              timestamptz
);

-- Document counts per client, from prod: what actually sits in the database,
-- as opposed to what the transfer mail said was sent.
create table if not exists client_document_counts (
  id                  bigint generated always as identity primary key,
  dsp_short_code      text,
  fein                text,
  company_name        text,
  documents           integer,
  employees_with_docs integer,
  total_employees     integer,
  active_employees    integer,
  checked_at          timestamptz
);

-- Read-only to the app: signed-in users may select, nobody may write.
alter table api_activity_runs      enable row level security;
alter table payroll_health         enable row level security;
alter table client_data_coverage   enable row level security;
alter table document_transfer      enable row level security;
alter table client_document_counts enable row level security;

drop policy if exists api_read  on api_activity_runs;
drop policy if exists ph_read   on payroll_health;
drop policy if exists cov_read  on client_data_coverage;
drop policy if exists doc_read  on document_transfer;
drop policy if exists dcnt_read on client_document_counts;

create policy api_read  on api_activity_runs      for select to authenticated using (true);
create policy ph_read   on payroll_health         for select to authenticated using (true);
create policy cov_read  on client_data_coverage   for select to authenticated using (true);
create policy doc_read  on document_transfer      for select to authenticated using (true);
create policy dcnt_read on client_document_counts for select to authenticated using (true);

-- PostgREST caches the schema; without this the app 404s on the new tables.
notify pgrst, 'reload schema';
