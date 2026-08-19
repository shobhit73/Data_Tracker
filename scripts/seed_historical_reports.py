"""Build the historical-data report catalogue and the tracking scope.

Source of truth for the report list is the reference document
"ADP_paycom_report_historical_requirements.docx"
(Drive id 1Lp3By25bIlOMwAVAt_LFiWGjgDZPKrCQ), which Shobhit shared on the
"Historical Data" mail thread after Dheeraj's feedback.

Three tables:
  historical_report_catalog  - the fixed list of reports per vendor
  historical_scope           - which DSPs are being tracked, and when they entered
  historical_report_status   - per DSP per report: did it arrive or not

Scope rule (agreed with the team):
  * DSPs whose previous_system is 'New' are excluded entirely — they were on no
    platform before, so there is nothing to migrate.
  * A DSP ENTERS scope when it is migrating from ADP/Paycom AND an onboarding
    API has run for it in the last SCOPE_DAYS days. The census run marks the
    point where the clock starts.
  * The window controls entry only. A DSP stays in scope until every one of its
    reports is Received — otherwise unfinished work would silently disappear
    from the dashboard once the window passed.

Why 90 days (developer-directed, 19 Aug 2026; was 30):
    The window exists to mirror how long the old platform is still reachable.
    ADP/Paycom access is typically revoked around 90 days after the census run,
    and once it is gone the data cannot be pulled at any price — so the tracking
    window has to cover the whole period in which a download is still possible.
    At 30 days the dashboard stopped showing clients that were still perfectly
    collectable, which is the expensive direction to be wrong in.

    Revocation is not punctual, so it is not modelled: when a client's access is
    actually cut off, drop it by hand with remove_historical_scope_clients.py.
    The 90 days is the outer bound, not a promise.
"""
import datetime

from supabase_helper import connect

SCOPE_DAYS = 90

# Most reports are a single deliverable. Two ADP reports are not: Payroll
# History comes as one file per calendar year, and Audit Trail is pulled a
# quarter at a time. Those are tracked file-by-file so a half-finished pull is
# visible instead of one tick hiding three missing years.
UNIT_TYPES = {
    ("ADP", "Payroll History"): "year",
    ("ADP", "Audit Trail"): "quarter",
}


def expected_units(unit_type, today=None):
    """The list of files expected for a report today.

    Deliberately recomputed rather than stored: the quarter list grows as the
    year progresses, and a new year adds a Payroll History file. Generating it
    means the checklist stays right without anyone editing a seed list."""
    today = today or datetime.date.today()
    y = today.year
    if unit_type == "year":
        # "One file per calendar year: current year - 3 ... current year"
        return [str(v) for v in range(y - 3, y + 1)]
    if unit_type == "quarter":
        # "prior year Q1-Q4 + current year quarters to date" — the running
        # quarter counts, because a partial pull is still expected.
        units = [f"{y - 1} Q{q}" for q in range(1, 5)]
        units += [f"{y} Q{q}" for q in range(1, (today.month - 1) // 3 + 2)]
        return units
    return ["Report"]

# (category, report_name, year_range) in the order the reference doc lists them.
PAYCOM = [
    ("Time-Off", "Employee Time-Off", "Current year + prior year (2 files)"),
    ("Time-Off", "Holiday/Blackout", "Current year + prior year (2 files)"),
    ("Time-Off", "Time-Off Audit", "Current year + prior year (2 files)"),
    ("Time-Off", "Time-Off Summary", "Current year + prior year (2 files)"),
    ("Time-Off", "Salary Time Off Absence Tracking",
     "Current year + prior year (2 files — report caps at 1 year per pull)"),

    ("Time & Attendance", "Break/Lunch Duration", "Current year + prior year"),
    ("Time & Attendance", "Employee Punch Change",
     "Quarterly — prior year Q1–Q4 + current year quarters to date"),
    ("Time & Attendance", "Employee Rates by Allocation", "Current year + prior year"),
    ("Time & Attendance", "Hours Worked vs Threshold", "Current year + prior year"),
    ("Time & Attendance", "Labor Allocation", "Current year + prior year"),
    ("Time & Attendance", "Labor Analysis/Overtime", "Current year + prior year"),
    ("Time & Attendance", "Missed Break/Lunch", "Current year + prior year"),
    ("Time & Attendance", "Missing Punch", "Current year + prior year"),
    ("Time & Attendance", "Pay Class Effective Date", "Current year + prior year"),
    ("Time & Attendance", "Punch Audit", "Current year + prior year"),
    ("Time & Attendance", "Punches Outside Current Allocation", "Current year + prior year"),
    ("Time & Attendance", "Time Between Shifts", "Current year + prior year"),
    ("Time & Attendance", "Time Detail", "Current year + prior year"),
    ("Time & Attendance", "Timecard Approval", "Current year + prior year"),
    ("Time & Attendance", "Total Hours by Time Range", "Current year + prior year"),
    ("Time & Attendance", "Total Hours Summary by Allocation", "Current year + prior year"),
    ("Time & Attendance", "Total Hours Summary", "Current year + prior year"),
    ("Time & Attendance", "Zero Hours Summary", "Current year + prior year"),

    ("Accrual", "Accrual Balances", "Current (snapshot — no date range on this form)"),
    ("Accrual", "Accrual Detail", "Current year + prior year"),
    ("Accrual", "Accrual Summary", "Current year + prior year"),
    ("Accrual", "Historical Accrual Data", "Current (snapshot — no date range on this form)"),

    ("HR & Audit", "Effective Dates", "Jan 1 of prior year → today"),
    ("HR & Audit", "Employee Changes", "Jan 1 of prior year → today"),
    ("HR & Audit", "Employee Dates", "Current (snapshot)"),
    ("HR & Audit", "Rate History", "Jan 1 of prior year → today"),
    ("HR & Audit", "Employee Accrual", "Current (snapshot)"),
    ("HR & Audit", "Equifax TWN Feed", "Current (snapshot)"),
    ("HR & Audit", "Employee 3rd Party Payee", "Current (snapshot)"),
    ("HR & Audit", "Employee Rates", "Current (snapshot)"),
    ("HR & Audit", "Employee Position", "Current (snapshot)"),
    ("HR & Audit", "Position Discrepancy", "Current (snapshot)"),
    ("HR & Audit", "Position Management Audit", "Current year + prior year"),
    ("HR & Audit", "Point-in-Time", "Current (snapshot)"),
    ("HR & Audit", "Changed Contact", "Jan 1 of prior year → today"),
    ("HR & Audit", "Form I-9 Audit Report", "Jan 1 of (current year − 3) → today"),

    ("Payroll", "Prior Payroll (Advanced Report Writer, consolidated)",
     "Jan 1 of (current year − 3) → today — 1 consolidated file"),

    ("E-Verify", "E-Verify Cases (grid export)",
     "Hire Date on/after Jan 1, 2023 — Paycom's own export"),
    ("E-Verify", "E-Verify Case Details (all cases)",
     "Hire Date on/after Jan 1, 2023 — 1 consolidated CSV"),
]

ADP = [
    ("Payroll", "Payroll History",
     "One file per calendar year: current year − 3, − 2, − 1, and current (4 files)"),

    ("Time Off", "Time Off Balance Detail", "Current (point-in-time balance report)"),
    ("Time Off", "Time Off Balance Summary", "Current (point-in-time balance report)"),
    ("Time Off", "Time Off Policy Assignment", "Current (point-in-time balance report)"),
    ("Time Off", "Time Off Request", "Current (point-in-time balance report)"),

    ("Time & Attendance", "Timecard Report with Supervisor Approval",
     "Jan 1 of prior year → today — 1 file"),
    ("Time & Attendance", "Timecard Report with Notes", "Jan 1 of prior year → today — 1 file"),
    ("Time & Attendance", "Timecard Exception Report", "Jan 1 of prior year → today — 1 file"),

    ("Audit Trail", "Audit Trail",
     "Quarterly — prior year Q1–Q4 + current year quarters to date"),

    ("Form I-9 / E-Verify", "Form I-9 and E-Verify Information",
     "Current only — ADP's report form has no date-range filter"),
]

# Reports that are genuinely being pulled but are NOT in the reference document.
# in_reference_doc=false keeps the coverage honest and flags that the doc still
# needs updating. Each vendor's catalogue uses that VENDOR'S OWN report name,
# because that is what whoever runs the download will be looking for in the UI.
EXTRAS = {
    "Paycom": [
        # Garnishment: Spelman 2025 + 2026 landed in Drive on 12 Aug.
        ("Payroll", "Garnishment Report", "Current year + prior year"),
        # Qualified overtime — see the ADP note below. Paycom's export is named
        # "<timestamp>_estimated_qualified_premiums_report_<hash>.xlsx".
        ("Payroll", "Estimated Qualified Premiums Report",
         "Current (YTD) — Paycom's name for the qualified-overtime report"),
    ],
    "ADP": [
        # Wage garnishments create a lien, so ADP files the same thing under a
        # different name.
        ("Payroll", "Employee Lien Report",
         "Current year + prior year (ADP's name for the garnishment report)"),
        # OBBB "no tax on overtime": for tax years 2026-2028 the employer MUST
        # report qualified overtime (the FLSA premium — the "half" in
        # time-and-a-half, hours over 40/week only) on every pay stub and on the
        # W-2. A DSP migrating mid-year therefore has to carry its YTD qualified
        # overtime across, or the W-2 comes out wrong. One export, not per year.
        ("Payroll", "Qualified Overtime Wages And Tips", "Current (YTD)"),
    ],
}

DDL = """
create table if not exists historical_report_catalog (
    id           bigint generated always as identity primary key,
    vendor       text not null check (vendor in ('ADP','Paycom')),
    category     text not null,
    report_name  text not null,
    year_range   text,
    sort_order   int  not null,
    in_reference_doc boolean not null default true,
    unit_type    text not null default 'single'
                 check (unit_type in ('single','year','quarter')),
    unique (vendor, report_name)
);
alter table historical_report_catalog
    add column if not exists unit_type text not null default 'single';

create table if not exists historical_scope (
    dsp_short_code text primary key references client_overview(dsp_short_code) on delete cascade,
    vendor         text not null check (vendor in ('ADP','Paycom')),
    entered_on     date not null,
    completed_on   date,
    notes          text
);

-- One row per expected FILE, not per report: unit_label is '2024' for a
-- Payroll History year, '2025 Q3' for an Audit Trail quarter, and 'Report'
-- for everything that is a single deliverable.
create table if not exists historical_report_status (
    dsp_short_code text not null references historical_scope(dsp_short_code) on delete cascade,
    report_id      bigint not null references historical_report_catalog(id) on delete cascade,
    unit_label     text not null default 'Report',
    status         text not null default 'Pending'
                   check (status in ('Received','Pending','Not applicable')),
    file_count     int,
    checked_date   date,
    notes          text,
    updated_at     timestamptz not null default now(),
    primary key (dsp_short_code, report_id, unit_label)
);
create index if not exists idx_hrs_dsp on historical_report_status(dsp_short_code);

-- Clients that must NOT come back on the next refresh. The scope rule is a
-- live predicate: a client whose ADP/Paycom access has been revoked still
-- matches it for the rest of its 90 days, so deleting the scope row alone
-- lasts only until someone re-runs this script. Exclusion is the record of a
-- human decision that the rule cannot infer, and it outranks the rule.
create table if not exists historical_scope_excluded (
    dsp_short_code text primary key references client_overview(dsp_short_code) on delete cascade,
    reason         text not null,
    excluded_on    date not null default current_date,
    updated_at     timestamptz not null default now()
);

grant usage on schema public to anon, authenticated;
grant select on historical_report_catalog, historical_scope, historical_report_status,
  historical_scope_excluded to anon, authenticated;
"""

RLS = """
alter table {t} enable row level security;
drop policy if exists "anon_read_only" on {t};
create policy "anon_read_only" on {t} for select to anon using (true);
"""


def seed_catalog(cur):
    rows = []
    for vendor, items in (("Paycom", PAYCOM), ("ADP", ADP)):
        for i, (cat, name, yr) in enumerate(items):
            rows.append((vendor, cat, name, yr, i, True, UNIT_TYPES.get((vendor, name), "single")))
        for j, (cat, name, yr) in enumerate(EXTRAS[vendor]):
            rows.append((vendor, cat, name, yr, len(items) + j, False,
                         UNIT_TYPES.get((vendor, name), "single")))

    cur.executemany(
        "insert into historical_report_catalog "
        "(vendor, category, report_name, year_range, sort_order, in_reference_doc, unit_type) "
        "values (%s,%s,%s,%s,%s,%s,%s) "
        "on conflict (vendor, report_name) do update set "
        "category=excluded.category, year_range=excluded.year_range, "
        "sort_order=excluded.sort_order, in_reference_doc=excluded.in_reference_doc, "
        "unit_type=excluded.unit_type",
        rows,
    )
    return len(rows)


def refresh_scope(cur):
    """Add DSPs that have newly entered the window. Never removes anyone —
    ageing out is decided by completion, not by the calendar.

    A DSP qualifies when it is migrating from ADP or Paycom AND an onboarding
    API has run for it recently. Recent API activity is the signal that the
    migration is actually under way, which is a better trigger than the payroll
    go-live date alone: the data pull has to happen while access to the old
    platform still exists, and that work starts with the first API run.

    Caveat worth knowing: api_activity_runs is loaded from the PHIX-72859 CSV
    export, which is refreshed by hand. If that export is stale, recently
    started DSPs will not qualify yet — the rule is only as current as the
    export.

    Re-running is how a client enters, so anything the rule still matches comes
    back — which is what you want when the window widens (CDCL and TRKD, dropped
    on 15 Aug under the old 30-day rule, were asked back on 19 Aug). The one
    thing the rule cannot infer is that a client's ADP/Paycom access has been
    revoked early: it keeps matching for the rest of its 90 days. That case goes
    in historical_scope_excluded, checked here, and is written by
    remove_historical_scope_clients.py.
    """
    cur.execute(
        """
        insert into historical_scope (dsp_short_code, vendor, entered_on)
        select distinct c.dsp_short_code, c.previous_system, current_date
        from client_overview c
        join api_activity_runs a on a.fein = c.fein
        where c.previous_system in ('ADP','Paycom')
          and a.last_run_date >= current_date - %s
          and not exists (select 1 from historical_scope_excluded x
                          where x.dsp_short_code = c.dsp_short_code)
        on conflict (dsp_short_code) do nothing
        """,
        (SCOPE_DAYS,),
    )
    return cur.rowcount


def fill_status_rows(cur):
    """Give every in-scope DSP a Pending row for each expected FILE.

    Multi-unit reports expand into one row per year/quarter. Re-running only
    adds rows (a new quarter, a new year); existing statuses are never reset."""
    cur.execute("select id, vendor, report_name, unit_type from historical_report_catalog")
    catalog = cur.fetchall()
    cur.execute("select dsp_short_code, vendor from historical_scope")
    scope = cur.fetchall()

    rows = []
    for code, vendor in scope:
        for rid, rvendor, rname, unit_type in catalog:
            if rvendor != vendor:
                continue
            for unit in expected_units(unit_type):
                rows.append((code, rid, unit))

    cur.executemany(
        "insert into historical_report_status (dsp_short_code, report_id, unit_label, status) "
        "values (%s,%s,%s,'Pending') "
        "on conflict (dsp_short_code, report_id, unit_label) do nothing",
        rows,
    )
    return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def main():
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()

    # The status table gained unit_label in its primary key. Recreate it, but
    # only after confirming nothing has been marked yet — never silently drop
    # real tracking data.
    cur.execute("""
        select exists (select 1 from information_schema.columns
                       where table_name='historical_report_status' and column_name='unit_label')
    """)
    has_unit_label = cur.fetchone()[0]
    if not has_unit_label:
        cur.execute("""
            select exists (select 1 from information_schema.tables
                           where table_name='historical_report_status')
        """)
        if cur.fetchone()[0]:
            cur.execute("select count(*) from historical_report_status where status <> 'Pending'")
            marked = cur.fetchone()[0]
            if marked:
                raise SystemExit(
                    f"historical_report_status has {marked} rows already marked. "
                    "Migrate them before adding unit_label instead of dropping the table."
                )
            cur.execute("drop table historical_report_status")
            print("recreated historical_report_status with per-file rows (was empty)")

    cur.execute(DDL)
    for t in ("historical_report_catalog", "historical_scope", "historical_report_status"):
        cur.execute(RLS.format(t=t))

    n_cat = seed_catalog(cur)
    n_scope = refresh_scope(cur)
    n_status = fill_status_rows(cur)

    print(f"catalog:  {n_cat} reports upserted")
    print(f"scope:    {n_scope} DSPs newly added")
    print(f"status:   {n_status} report rows created")

    cur.execute(
        "select vendor, count(*) from historical_report_catalog group by vendor order by 1")
    print("\nreports per vendor:", dict(cur.fetchall()))

    cur.execute(
        """select s.dsp_short_code, c.dsp_name, s.vendor, s.entered_on,
                  count(*) filter (where r.status='Received') as received,
                  count(*) as total
           from historical_scope s
           join client_overview c on c.dsp_short_code = s.dsp_short_code
           left join historical_report_status r on r.dsp_short_code = s.dsp_short_code
           group by 1,2,3,4 order by s.entered_on desc, c.dsp_name""")
    print("\nin scope:")
    for code, name, vendor, entered, rec, tot in cur.fetchall():
        print(f"  {code:6s} {name[:30]:32s} {vendor:7s} entered {entered}  {rec}/{tot} received")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
