-- Phase 3 of the platform merge: a read-only copy of the DSP Historical Data
-- Tracker (the Google Sheet) inside the CRM, feeding the Data > Historical
-- tab. Run once in the Supabase SQL editor; destined for the CRM repo as
-- scripts/migrations/2026-09-29-phase3-historical.sql.
--
-- The SHEET remains the single source of truth. The Apps Script that sends
-- the daily 17:30 IST mail rewrites these three tables whole after each run
-- (service role; a push failure never costs the mail). Nothing in the app may
-- write here: RLS is SELECT-to-authenticated only.

-- One row per tracked client, with the counts precomputed at push time so the
-- app and the mail can never disagree on the arithmetic. N/A is excluded from
-- the ratio: expected = received + pending.
create table if not exists hist_clients (
  id             bigint generated always as identity primary key,
  dsp_short_code text,
  dsp_name       text,
  vendor         text,          -- ADP | Paycom
  implementor    text,
  folder_url     text,
  last_scanned   date,
  received       integer,
  pending        integer,
  not_applicable integer,
  pushed_at      timestamptz default now()
);

-- One row per expected report unit per client (the sheet's status cells,
-- long-format). status: Received | Pending | Not applicable.
create table if not exists hist_status (
  id             bigint generated always as identity primary key,
  dsp_short_code text,
  vendor         text,
  category       text,
  report_name    text,
  unit_label     text,
  status         text,
  pushed_at      timestamptz default now()
);

-- The sheet's Out of Scope tab: reason is one of the three dropdown values
-- ('Access revoked' | 'On hold' | 'Other - see notes'); the story is in notes.
create table if not exists hist_out_of_scope (
  id             bigint generated always as identity primary key,
  dsp_short_code text,
  dsp_name       text,
  reason         text,
  notes          text,
  pushed_at      timestamptz default now()
);

alter table hist_clients      enable row level security;
alter table hist_status       enable row level security;
alter table hist_out_of_scope enable row level security;

drop policy if exists hc_read on hist_clients;
drop policy if exists hs_read on hist_status;
drop policy if exists ho_read on hist_out_of_scope;

create policy hc_read on hist_clients      for select to authenticated using (true);
create policy hs_read on hist_status       for select to authenticated using (true);
create policy ho_read on hist_out_of_scope for select to authenticated using (true);

notify pgrst, 'reload schema';
