"""Populate historical_data_checklist, audit_coverage, api_activity_runs, and
open_items in Supabase from the data already assembled in dashboard/dsp_dashboard.html
(hand-researched from Drive/Rohit's email earlier this session) and
data/matrix_raw.tsv (script-generated from the PHIX-72859 CSV logs).

Adds a `notes` column to historical_data_checklist / audit_coverage first —
the source HTML carries useful caveat text (naming mismatches, split
locations, etc.) worth preserving, not just a bare status.
"""
import os
import sys

from supabase_helper import connect

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ALTER_SQL = """
alter table historical_data_checklist add column if not exists notes text;
alter table audit_coverage add column if not exists notes text;
alter table historical_data_checklist alter column vendor drop not null;
"""

# ---------------------------------------------------------------- Historical Data
# 14-client overall summary (from dsp_dashboard.html view-historical table)
HIST_OVERALL = [
    ("Flash Hub Delivery", "ADP", "Complete", "Payroll history, Time Off, Timecards, Audit Trail, I-9 all present"),
    ("North Star Parcel LLC", "ADP", "Complete", "Everything present, including all 7 Audit Trail quarters"),
    ("Lazo Logistics LLC", "ADP", "Nearly complete", "Missing Q2-2026 Audit Trail; 2 stray misfiled I-9 files"),
    ("InnovDel Inc", "ADP", "Partial", "Payroll History + Time Off done; no Timecards, Audit Trail, or I-9 yet"),
    ("First Line Logistics", "ADP", "Minimal", "Only 3 of 4 Payroll History years (2026 missing); no Time Off, Timecards, Audit Trail, or I-9"),
    ("Spelman Logistics Inc", "Paycom", "Not deep-audited", "Paycom's ~44-item checklist is separate — see callout"),
    ("Trek Delivery", None, "Not started", "No Historical Data folder yet"),
    ("Always More Logistics", "Paycom", "Not started", "No Historical Data folder yet"),
    ("High Distinction Logistics LLC", "ADP", "Not started", "No Historical Data folder yet"),
    ("Beck Logistics LLC", "ADP", "Not started", "No Historical Data folder yet"),
    ("CDC LOGISTICS, LLC", None, "Not started", "No Historical Data folder yet"),
    ("Stave Delivery", "Paycom", "Not started", "No Historical Data folder yet"),
    ("Kynect Express LLC", None, "Too new", "Client folder created 08/11 — only a kickoff deck so far"),
    ("Express Package System Inc.", None, "Too new", "Only an order form so far"),
]

# ADP checklist detail grid — 5 clients x 5 report categories
HIST_DETAIL = [
    ("Flash Hub Delivery", "ADP", "Payroll History", "2023-2025: 3/3; 2026: Present", None),
    ("Flash Hub Delivery", "ADP", "Time Off", "4/4", None),
    ("Flash Hub Delivery", "ADP", "Timecards", "3/3", None),
    ("Flash Hub Delivery", "ADP", "Audit Trail", "6/6 to date (Q3 not due)", None),
    ("Flash Hub Delivery", "ADP", "I-9", "Present", None),

    ("North Star Parcel LLC", "ADP", "Payroll History", "2023-2025: 3/3; 2026: Present", None),
    ("North Star Parcel LLC", "ADP", "Time Off", "4/4", None),
    ("North Star Parcel LLC", "ADP", "Timecards", "3/3", None),
    ("North Star Parcel LLC", "ADP", "Audit Trail", "7/7", None),
    ("North Star Parcel LLC", "ADP", "I-9", "Present", None),

    ("Lazo Logistics LLC", "ADP", "Payroll History", "2023-2025: 3/3; 2026: Present", None),
    ("Lazo Logistics LLC", "ADP", "Time Off", "4/4", None),
    ("Lazo Logistics LLC", "ADP", "Timecards", "3/3", None),
    ("Lazo Logistics LLC", "ADP", "Audit Trail", "6/7", "Missing Q2-2026"),
    ("Lazo Logistics LLC", "ADP", "I-9", "Present, +2 stray files", None),

    ("InnovDel Inc", "ADP", "Payroll History", "2023-2025: 3/3; 2026: Present", None),
    ("InnovDel Inc", "ADP", "Time Off", "4/4", None),
    ("InnovDel Inc", "ADP", "Timecards", "0/3", None),
    ("InnovDel Inc", "ADP", "Audit Trail", "0/7", None),
    ("InnovDel Inc", "ADP", "I-9", "Missing", None),

    ("First Line Logistics", "ADP", "Payroll History", "2023-2025: 3/3; 2026: Missing", None),
    ("First Line Logistics", "ADP", "Time Off", "0/4", None),
    ("First Line Logistics", "ADP", "Timecards", "0/3", None),
    ("First Line Logistics", "ADP", "Audit Trail", "0/7", None),
    ("First Line Logistics", "ADP", "I-9", "Missing", None),
]

# ---------------------------------------------------------------- Audit Coverage
AUDIT_CATEGORIES = ["Census", "Withholding", "Payment", "Prior Payroll", "Deduction", "Emergency Contact"]

# clients with a per-category breakdown: (client, {category: status}, {category: note})
AUDIT_DETAIL = [
    ("Flash Hub Delivery", {c: "Present" for c in AUDIT_CATEGORIES}, {}),
    ("First Line Logistics", {c: "Present" for c in AUDIT_CATEGORIES}, {}),
    (
        "InnovDel Inc",
        {**{c: "Present" for c in AUDIT_CATEGORIES}},
        {"Census": "Mail flagged as missing, but a file dated 08/07 exists named "
                   "\"Client_Uzio_ADP_Census…\" instead of \"InnovDel_…\" — likely a naming mismatch, not a real gap."},
    ),
    (
        "North Star Parcel LLC",
        {**{c: "Present" for c in AUDIT_CATEGORIES}, "Census": "Missing"},
        {},
    ),
    (
        "Lazo Logistics LLC",
        {**{c: "Present" for c in AUDIT_CATEGORIES}, "Census": "Missing"},
        {},
    ),
    (
        "Spelman Logistics Inc",
        {**{c: "Present" for c in AUDIT_CATEGORIES}, "Census": "Missing", "Payment": "Missing"},
        {},
    ),
    (
        "CDC LOGISTICS, LLC",
        {c: "Missing" for c in AUDIT_CATEGORIES if c != "Payment"} | {"Payment": "Present"},
        {},
    ),
]

# clients with only an overall folder-state note, no per-category breakdown
AUDIT_OVERALL_ONLY = [
    ("Trek Delivery", "Not applicable", "Folder empty"),
    ("Always More Logistics", "Not applicable", "Folder empty"),
    ("High Distinction Logistics LLC", "Not applicable", "Folder empty"),
    ("Beck Logistics LLC", "Not applicable", "Folder empty"),
    ("Stave Delivery", "Not applicable", "Folder empty"),
    ("Express Package System Inc.", "Not applicable", "No Audit Files folder"),
    ("Kynect Express LLC", "Not applicable", "Too new — client folder created 08/11, after the mail ran"),
]

CHECKED_DATE = "2026-08-11"  # date of Rohit's mail this snapshot is based on

# ---------------------------------------------------------------- Open Items
OPEN_ITEMS = [
    ("Needs action", "Spelman — Employee Contributions mostly failing",
     "Succeeded for only 2 of 143 records on its one 07/13 run (140 failed — no contribution mapping "
     "configured). Never re-run since, unlike every other module."),
    ("Needs action", "Flash Hub — Census failures dominated by one error",
     "Re-ran 5 times between 06/29 and 07/31; \"work location not recognized\" still accounts for 572 "
     "of 588 outstanding failures — the dominant, unresolved error for this client."),
    ("Needs action", "Lazo — Q2-2026 Audit Trail missing",
     "Q1 and Q3 are both present, so this looks like a skipped pull rather than \"not due yet.\""),
    ("Worth checking", "Lazo / North Star / Flash Hub — current-year payroll history split location",
     "2026 payroll history lives in each client's \"Payroll Setup\" folder as quarterly cuts, not "
     "alongside the 2023-2025 annual files in Historical Data. Same data, split location — worth "
     "deciding whether that's the intended pattern going forward."),
    ("Worth checking", "Lazo — misfiled I-9 exports",
     "Two files named \"EI9 Audit Trail…\" sit loose in the Historical Data root instead of inside the "
     "Audit Trail folder — likely a typo'd/misfiled I-9 export."),
    ("Worth checking", "InnovDel — Census naming mismatch",
     "Audit-coverage mail says Census is missing, but a Census audit file dated 08/07 exists in the "
     "folder named \"Client_Uzio_ADP_Census…\" instead of \"InnovDel_…\". Likely a naming-pattern miss "
     "in the scanner, not an actual gap — worth confirming and fixing the naming convention."),
    ("Worth checking", "InnovDel / First Line — tracks out of sync",
     "Both show complete Audit Coverage (or near it) while Historical Data collection is barely started "
     "for them. The two tracking modules run independently — a client can look \"done\" on one and "
     "untouched on the other."),
    ("Pending", "Spelman — Paycom checklist not yet audited item-by-item",
     "Paycom's ~44-item historical-data checklist hasn't been audited item-by-item yet, only the "
     "top-level folders and a few loose reports."),
    ("Pending", "8 clients with no Historical Data folder yet",
     "Trek Delivery, Always More Logistics, High Distinction, Beck Logistics, CDC Logistics, Stave "
     "Delivery, Kynect Express, Express Package System — most also show empty or missing Audit Files "
     "folders. Same rollout wave, likely just not started."),
    ("Pending", "Employee headcount per client not sourced",
     "Needs a confirmed table/column before it can go on the Overview cards."),
]


def populate_historical(cur):
    rows = []
    for client, vendor, status, notes in HIST_OVERALL:
        rows.append((client, vendor, "Overall", status, CHECKED_DATE, notes))
    for client, vendor, category, status, notes in HIST_DETAIL:
        rows.append((client, vendor, category, status, CHECKED_DATE, notes))

    sql = (
        "insert into historical_data_checklist "
        "(client_name, vendor, report_category, status, last_checked_date, notes) "
        "values (%s,%s,%s,%s,%s,%s) "
        # coalesce so a blank in the seed data can't erase a hand-entered value
        "on conflict (client_name, report_category) do update set "
        "vendor=coalesce(excluded.vendor, historical_data_checklist.vendor), "
        "status=coalesce(excluded.status, historical_data_checklist.status), "
        "last_checked_date=coalesce(excluded.last_checked_date, historical_data_checklist.last_checked_date), "
        "notes=coalesce(excluded.notes, historical_data_checklist.notes), updated_at=now()"
    )
    for r in rows:
        cur.execute(sql, r)
    return len(rows)


def populate_audit(cur):
    rows = []
    for client, statuses, notes_map in AUDIT_DETAIL:
        for cat in AUDIT_CATEGORIES:
            rows.append((client, cat, statuses[cat], CHECKED_DATE, "email+drive", notes_map.get(cat)))
    for client, status, note in AUDIT_OVERALL_ONLY:
        rows.append((client, "Overall", status, CHECKED_DATE, "email", note))

    sql = (
        "insert into audit_coverage (client_name, audit_category, status, checked_date, source, notes) "
        "values (%s,%s,%s,%s,%s,%s) "
        "on conflict (client_name, audit_category) do update set "
        "status=coalesce(excluded.status, audit_coverage.status), "
        "checked_date=coalesce(excluded.checked_date, audit_coverage.checked_date), "
        "source=coalesce(excluded.source, audit_coverage.source), "
        "notes=coalesce(excluded.notes, audit_coverage.notes), updated_at=now()"
    )
    for r in rows:
        cur.execute(sql, r)
    return len(rows)


def populate_api_activity(cur):
    import gen_matrix  # runs its own top-level extraction; reuses its computed dicts

    rows = []
    for fein, name in gen_matrix.clients:
        vendor = gen_matrix.client_vendor[fein]
        for sec_key, _label in gen_matrix.MODULES:
            cell = gen_matrix.data.get(fein, {}).get(sec_key)
            if not cell:
                continue
            last, by = cell
            rows.append((fein, name, vendor, sec_key, last, by))

    sql = (
        "insert into api_activity_runs (fein, client_name, vendor, module_key, last_run_date, run_by) "
        "values (%s,%s,%s,%s,%s,%s) "
        "on conflict (fein, module_key) do update set "
        "client_name=excluded.client_name, vendor=excluded.vendor, "
        "last_run_date=excluded.last_run_date, run_by=excluded.run_by, updated_at=now()"
    )
    for r in rows:
        cur.execute(sql, r)
    return len(rows)


def populate_open_items(cur):
    """DISABLED on purpose — open_items is human-owned.

    This used to `delete from open_items` and re-seed from the OPEN_ITEMS list
    above, which is fine for a one-off but destroys hand-written items every
    time it runs. Now that the populate scripts run on a schedule, this table is
    curated in Supabase by a person and no script writes to it.

    The OPEN_ITEMS list is kept above only as the record of the original seed.
    """
    cur.execute("select count(*) from open_items")
    return cur.fetchone()[0]


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute(ALTER_SQL)

    n_hist = populate_historical(cur)
    n_audit = populate_audit(cur)
    n_api = populate_api_activity(cur)
    n_open = populate_open_items(cur)
    conn.commit()

    print(f"historical_data_checklist: {n_hist} rows upserted")
    print(f"audit_coverage: {n_audit} rows upserted")
    print(f"api_activity_runs: {n_api} rows upserted")
    print(f"open_items: {n_open} rows LEFT UNTOUCHED (human-owned)")

    for t in ("historical_data_checklist", "audit_coverage", "api_activity_runs", "open_items"):
        cur.execute(f"select count(*) from {t}")
        print(f"  {t} total now: {cur.fetchone()[0]}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
