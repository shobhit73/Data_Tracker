"""One-off, developer-directed edit to the Stave Delivery historical checklist row.

historical_data_checklist is human-owned - no scheduled job writes to it. This
script exists because Shobhit checked the Drive folder on 15 Aug 2026, found it
populated, and asked for the row to be corrected. It touches exactly one row.

What the Drive check found (folder 1p309L_gSzmGTJv1Ra8OfJRxh9S8-FyLW):
  Prior Payroll History Per Pay Period Wise  4 files  (2023/2024/2025/2026-to-date)
  Time and Attendance Report                40 files  (2025+2026 pairs + quarterly punch-change)
  HR and Audit Reports                       0 files  (folder created, still empty)

Status is 'Partial' rather than 'Complete': the HR and Audit Reports subfolder is
empty, and like Spelman (the other Paycom client) this is a folder inventory, not
a line-by-line verification against Paycom's ~44-item checklist. Stave keeps the
Paycom convention of a single 'Overall' row - no per-category rows are added, so
the two Paycom clients stay consistent with each other.
"""
from supabase_helper import connect

CLIENT = "Stave Delivery"
CATEGORY = "Overall"
STATUS = "Partial"
CHECKED = "2026-08-15"

NOTE = (
    "Historical Data folder created 08/13 and populated 08/15. "
    "Prior Payroll History Per Pay Period Wise: 4 files (2023, 2024, 2025, "
    "2026-to-date). Time and Attendance Report: 40 files - 2025+2026 pairs of "
    "PunchAudit, TimeDetail, TimecardApproval, MissingPunch, MissedBreakLunch, "
    "LaborAllocation, LaborAnalysisOvertime, HoursWorkedVsThreshold, "
    "TotalHoursSummary (3 variants), TimeBetweenShifts, ZeroHours, "
    "PayClassEffectiveDate, EmployeeRatesByAllocation, "
    "PunchesOutsideCurrentAllocation, plus EmployeePunchChange quarterly "
    "(2025 Q1-Q4, 2026 Q1-Q3). HR and Audit Reports subfolder exists but is "
    "EMPTY - that is the open gap. Not deep-audited against Paycom's ~44-item "
    "checklist (see the Spelman callout); this is a folder inventory, not a "
    "line-by-line verification."
)

UPDATE = """
update historical_data_checklist
   set status = %s, last_checked_date = %s, notes = %s, updated_at = now()
 where client_name = %s and report_category = %s
"""


def main():
    conn = connect()
    cur = conn.cursor()

    cur.execute(
        "select status, last_checked_date, notes from historical_data_checklist "
        "where client_name = %s and report_category = %s",
        (CLIENT, CATEGORY),
    )
    before = cur.fetchone()
    if before is None:
        raise SystemExit(f"No {CLIENT} / {CATEGORY} row found - aborting, "
                         "this script only updates, it never inserts.")
    print("BEFORE:", before)

    cur.execute(UPDATE, (STATUS, CHECKED, NOTE, CLIENT, CATEGORY))
    if cur.rowcount != 1:
        conn.rollback()
        raise SystemExit(f"Expected to update exactly 1 row, matched "
                         f"{cur.rowcount} - rolled back.")
    conn.commit()
    print("rows updated:", cur.rowcount)

    cur.execute(
        "select client_name, vendor, report_category, status, last_checked_date, notes "
        "from historical_data_checklist where client_name = %s",
        (CLIENT,),
    )
    for row in cur.fetchall():
        print("AFTER:", row)

    cur.execute("select count(*) from historical_data_checklist")
    print("table row count (must be unchanged at 39):", cur.fetchone()[0])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
