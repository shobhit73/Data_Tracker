-- DSP Ops Dashboard — Supabase schema
-- One table per dashboard view (see CLAUDE.md "The 5 views and their scope").
-- client_overview / client_work_locations are partially prod-DB-derived;
-- historical_data_checklist / audit_coverage are hand-researched (Drive/email) and
-- always need manual entry regardless of backend; api_activity_runs is fully
-- script-generated from the PHIX-72859 CSV logs (see gen_matrix.py); open_items
-- is hand-curated.

-- dsp_short_code is the business key: it's present for every DSP in Shruti's
-- sheet, whereas fein only exists once a client is live in prod. fein is
-- backfilled later (per client) via a prod-query name/short-code match.
create table if not exists client_overview (
    dsp_short_code        text primary key,
    dsp_name              text not null,
    fein                  text unique,
    vendor                text check (vendor in ('ADP', 'Paycom')),
    expected_tt_live_date date,
    actual_tt_live_date   date,
    payroll_cutoff_date   date,
    payroll_live_date     date,
    rag_status            text check (rag_status in ('Red', 'Amber', 'Green')),
    final_status           text,
    frequency              text,
    previous_system        text,
    implementor             text,
    state                   text,
    source_row_notes        text,  -- freeform: anything odd found while extracting (e.g. vendor undetermined)
    updated_at              timestamptz not null default now()
);

create table if not exists client_work_locations (
    id                      bigint generated always as identity primary key,
    dsp_short_code          text not null references client_overview(dsp_short_code) on delete cascade,
    work_location_name      text,
    address_line1           text,
    address_line2           text,
    city                    text,
    state                   text,
    zip_code                text,
    is_primary              boolean not null default false
);
create index if not exists idx_client_work_locations_dsp on client_work_locations(dsp_short_code);

create table if not exists historical_data_checklist (
    id                bigint generated always as identity primary key,
    client_name       text not null,
    vendor            text not null check (vendor in ('ADP', 'Paycom')),
    report_category   text not null,  -- Payroll History / Time Off / Timecards / Audit Trail / I-9
    status             text not null, -- Complete / Nearly complete / Partial / Minimal / Not started / Too new
    last_checked_date date,
    updated_at         timestamptz not null default now(),
    unique (client_name, report_category)
);

create table if not exists audit_coverage (
    id             bigint generated always as identity primary key,
    client_name    text not null,
    audit_category text not null,  -- Census / Withholding / Payment / Deductions / Worker's Comp / etc.
    status          text not null,  -- Present / Missing / Not applicable
    checked_date   date,
    source          text,           -- 'email' or 'drive'
    updated_at      timestamptz not null default now(),
    unique (client_name, audit_category)
);

create table if not exists api_activity_runs (
    id             bigint generated always as identity primary key,
    fein           text not null,
    client_name    text not null,
    vendor         text not null check (vendor in ('ADP', 'Paycom')),
    module_key     text not null,  -- EmployeeCensus / PriorPayroll / ... (matches gen_matrix.py MODULES)
    last_run_date  date,
    run_by         text,
    updated_at     timestamptz not null default now(),
    unique (fein, module_key)
);
create index if not exists idx_api_activity_runs_fein on api_activity_runs(fein);

create table if not exists open_items (
    id           bigint generated always as identity primary key,
    severity     text not null check (severity in ('Needs action', 'Worth checking', 'Pending')),
    title        text not null,
    description  text,
    status        text not null default 'Open',
    date_added   date not null default current_date
);
