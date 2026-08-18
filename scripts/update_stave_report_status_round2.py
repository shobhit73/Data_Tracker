"""Second Stave (STAV) pass - the Time-Off, Accrual and HR & Audit reports that
landed after the first sync.

Re-checked Drive on 15 Aug 2026 (~12:20 UTC). Since the 11:30 listing that
drove update_stave_report_status.py, two new subfolders appeared and the empty
one filled up:

  Time-Off              (created 12:13)  10 files  -> 5 reports
  Accrual               (created 12:03)   5 files  -> 3 reports
  HR and Audit Reports  (was empty)      17 files  -> 14 reports + Garnishment

Unchanged since the first pass and deliberately not rewritten here:
  Time and Attendance Report                 41 files
  Prior Payroll History Per Pay Period Wise   4 files

That takes STAV from 19/45 to 42/45. The 3 still Pending have no file in Drive:
Historical Accrual Data, and both E-Verify reports.

Note on Garnishment (report 45): the catalog files it under 'Payroll' but the
two files sit in the HR and Audit Reports subfolder. Recorded where they
actually are, with a note - not moved, not renamed.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DSP = "STAV"
CHECKED = "2026-08-15"

TIMEOFF_FOLDER = "https://drive.google.com/drive/folders/1K_FYXFxSXk6vM9m0XDMhh4EfvqjMSvsK"
ACCRUAL_FOLDER = "https://drive.google.com/drive/folders/1a0NBF-gV_ZAgQuxyKp6Kt2woGfVw-w-K"
HR_FOLDER = "https://drive.google.com/drive/folders/1XH1Ag-kqPK3adCkQWGLb9WAMmlcfWOv_"

# report_id -> (files, folder_url, notes)
RECEIVED = {
    # --- Time-Off (5) --------------------------------------------------------
    1: (["EmployeeTimeOff_2025.xlsx", "EmployeeTimeOff_2026.xlsx"], TIMEOFF_FOLDER, None),
    2: (["HolidayBlackout_2025.xlsx", "HolidayBlackout_2026.xlsx"], TIMEOFF_FOLDER, None),
    3: (["TimeOffAudit_2025.xlsx", "TimeOffAudit_2026.xlsx"], TIMEOFF_FOLDER, None),
    4: (["TimeOffSummary_2025.xlsx", "TimeOffSummary_2026.xlsx"], TIMEOFF_FOLDER, None),
    5: (["SalaryTimeOffAbsenceTracking_2025.xlsx",
         "SalaryTimeOffAbsenceTracking_2026.xlsx"], TIMEOFF_FOLDER,
        "Pulled as 2 single-year files, which is what the catalog expects - "
        "this report caps at 1 year per pull."),
    # --- Accrual (3 of 4; Historical Accrual Data still missing) -------------
    24: (["AccrualBalances.xlsx"], ACCRUAL_FOLDER,
         "Snapshot report - one file, no date range, per the catalog."),
    25: (["AccrualDetail_2025.xlsx", "AccrualDetail_2026.xlsx"], ACCRUAL_FOLDER, None),
    26: (["AccrualSummary_2025.xlsx", "AccrualSummary_2026.xlsx"], ACCRUAL_FOLDER, None),
    # --- HR & Audit (14) -----------------------------------------------------
    28: (["EffectiveDates_2025-to-date.xlsx"], HR_FOLDER, None),
    29: (["EmployeeChanges_2025-to-date.xlsx"], HR_FOLDER, None),
    30: (["EmployeeDates.xlsx"], HR_FOLDER, None),
    31: (["RateHistory_2025-to-date.xlsx"], HR_FOLDER, None),
    32: (["EmployeeAccrual.xlsx"], HR_FOLDER, None),
    33: (["EquifaxTWNFeed.xlsx"], HR_FOLDER, None),
    34: (["Employee3rdPartyPayee.xlsx"], HR_FOLDER, None),
    35: (["EmployeeRates.xlsx"], HR_FOLDER, None),
    36: (["EmployeePosition.xlsx"], HR_FOLDER, None),
    37: (["PositionDiscrepancy.xlsx"], HR_FOLDER, None),
    38: (["PositionManagementAudit_2025.xlsx", "PositionManagementAudit_2026.xlsx"],
         HR_FOLDER, None),
    39: (["PointInTime.xlsx"], HR_FOLDER, None),
    40: (["ChangedContact_2025-to-date.xlsx"], HR_FOLDER, None),
    41: (["FormI9Audit_2023-to-date.xlsx"], HR_FOLDER,
         "Single file covering 2023 to date, matching the catalog's "
         "(current year - 3) range."),
    # --- Payroll -------------------------------------------------------------
    45: (["GarnishmentReport_2025.xlsx", "GarnishmentReport_2026.xlsx"], HR_FOLDER,
         "Catalog files this under Payroll, but both files are stored in the "
         "HR and Audit Reports subfolder in Drive."),
}

UPDATE = """
update historical_report_status
   set status = 'Received', file_name = %s, folder_url = %s, notes = %s,
       checked_date = %s, updated_at = now()
 where dsp_short_code = %s and report_id = %s and unit_label = 'Report'
"""


def main():
    conn = connect()
    cur = conn.cursor()

    cur.execute(
        "select status, count(*) from historical_report_status "
        "where dsp_short_code = %s group by 1", (DSP,))
    print("BEFORE:", dict(cur.fetchall()))

    for report_id, (files, folder, note) in sorted(RECEIVED.items()):
        cur.execute(UPDATE, (", ".join(files), folder, note, CHECKED, DSP, report_id))
        if cur.rowcount != 1:
            conn.rollback()
            raise SystemExit(
                f"report_id {report_id} matched {cur.rowcount} rows, expected 1 "
                f"- rolled back, nothing written.")

    cur.execute("select count(*) from historical_report_status where dsp_short_code = %s", (DSP,))
    total = cur.fetchone()[0]
    if total != 45:
        conn.rollback()
        raise SystemExit(f"STAV row count changed to {total}, expected 45 - rolled back.")

    conn.commit()

    cur.execute(
        "select status, count(*) from historical_report_status "
        "where dsp_short_code = %s group by 1", (DSP,))
    print("AFTER: ", dict(cur.fetchall()))

    print("\nStill Pending:")
    cur.execute(
        "select c.category, c.report_name from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "where s.dsp_short_code = %s and s.status = 'Pending' order by c.sort_order", (DSP,))
    for category, name in cur.fetchall():
        print(f"  {category:10} {name}")

    cur.execute("select count(*) from historical_report_status where status = 'Received'")
    received = cur.fetchone()[0]
    cur.execute("select count(*) from historical_report_status")
    print(f"\nWhole window: {received} of {cur.fetchone()[0]} expected files received")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
