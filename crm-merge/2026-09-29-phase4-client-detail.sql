-- Phase 4 of the platform merge: the dashboard's client-detail facts join the
-- CRM's Client 360 page. Three more read-only reporting tables, refreshed by
-- push_data_views.py like the Phase 2 five. Run once in the Supabase SQL
-- editor; destined for the CRM repo's scripts/migrations/.

-- One row per DSP from the ops tracker: identity and profile facts the CRM's
-- own clients table does not carry (FEIN, state, pay frequency, benefits).
create table if not exists client_profile (
  id                      bigint generated always as identity primary key,
  dsp_short_code          text,
  dsp_name                text,
  fein                    text,
  vendor                  text,
  previous_system         text,
  implementor             text,
  state                   text,
  frequency               text,
  rag_status              text,
  final_status            text,
  expected_tt_live_date   date,
  actual_tt_live_date     date,
  payroll_cutoff_date     date,
  payroll_live_date       date,
  benefits_requirement    text,
  benefits_details        text,
  benefits_deductions_via text,
  source_row_notes        text,
  updated_at              timestamptz
);

-- What prod itself records per client: real TT punches and real pay runs, as
-- opposed to what any tracker says.
create table if not exists client_system_activity (
  id                    bigint generated always as identity primary key,
  dsp_short_code        text,
  fein                  text,
  company_name          text,
  tt_setup_completed    boolean,
  tt_enrolled_employees integer,
  tt_first_live_date    date,
  tt_first_entry_date   date,
  tt_last_entry_date    date,
  tt_employees_punched  integer,
  tt_live_entries       integer,
  tt_imported_entries   integer,
  pr_first_normal_date  date,
  pr_last_normal_date   date,
  pr_normal_runs        integer,
  pr_last_run_employees integer,
  pr_prior_loads        integer,
  checked_date          date,
  updated_at            timestamptz
);

create table if not exists client_work_locations (
  id                 bigint generated always as identity primary key,
  dsp_short_code     text,
  work_location_name text,
  address_line1      text,
  address_line2      text,
  city               text,
  state              text,
  zip_code           text,
  is_primary         boolean
);

alter table client_profile         enable row level security;
alter table client_system_activity enable row level security;
alter table client_work_locations  enable row level security;

drop policy if exists cp_read  on client_profile;
drop policy if exists csa_read on client_system_activity;
drop policy if exists cwl_read on client_work_locations;

create policy cp_read  on client_profile         for select to authenticated using (true);
create policy csa_read on client_system_activity for select to authenticated using (true);
create policy cwl_read on client_work_locations  for select to authenticated using (true);

notify pgrst, 'reload schema';
