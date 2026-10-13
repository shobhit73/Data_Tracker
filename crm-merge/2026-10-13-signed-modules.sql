-- "Signed modules" box on the Client 360 page: which modules this client's
-- signed order form actually covers, extracted from Cuzio's customer pages.
-- One read-only reporting row per client, same posture as the other client_*
-- tables (RLS select-to-authenticated; writes via service key only).
-- Run once in the CRM's Supabase SQL editor; copy into the CRM repo's
-- scripts/migrations/ afterwards.

create table if not exists client_signed_modules (
  id                   bigint generated always as identity primary key,
  dsp_short_code       text,
  dsp_name             text,
  -- [{"name":"Payroll","status":"included","note":"..."}, ...]
  -- status: included | tbd | na
  modules              jsonb,
  notes                text,
  source               text,          -- the Cuzio page the facts came from
  contract_signed_date date,
  extracted_at         timestamptz default now()
);

alter table client_signed_modules enable row level security;
drop policy if exists csm_read on client_signed_modules;
create policy csm_read on client_signed_modules
  for select to authenticated using (true);

notify pgrst, 'reload schema';
