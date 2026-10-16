-- Prior-payroll tax mapping per DSP: how each source (ADP/Paycom) tax code was
-- mapped to a Uzio tax code when prior payroll was loaded. Read off the
-- clients' tax mapping files in Drive; state is derived from the Unique Tax
-- ID's FIPS prefix (17-... = IL). Read-only reporting table, replaced in full
-- by crm-merge/push_tax_mapping.py (service role); the app only selects.
-- Run once in the Supabase SQL editor (CRM project). Idempotent.
create table if not exists client_tax_mapping (
  id             bigint generated always as identity primary key,
  dsp_short_code text,
  client_name    text,
  state          text,          -- two-letter state, or 'Federal'
  tax_kind       text,          -- SIT, SUTA, FIT, MEDI, FICA, SDI, CITY, ... from the Unique Tax ID
  source_code    text,
  source_name    text,
  source_desc    text,          -- e.g. W/H Taxes | Client Side Liabilities
  uzio_code      text,
  unique_tax_id  text,
  uzio_desc      text,
  uzio_sub_desc  text,
  file_title     text,
  file_url       text,
  loaded_date    date
);
create index if not exists client_tax_mapping_code on client_tax_mapping (dsp_short_code);
alter table client_tax_mapping enable row level security;
drop policy if exists tax_mapping_read on client_tax_mapping;
create policy tax_mapping_read on client_tax_mapping for select to authenticated using (true);
grant select on client_tax_mapping to authenticated;
grant all on client_tax_mapping to service_role;
