"""Mark Stave Delivery's (STAV) collected Paycom reports as Received.

This writes to historical_report_status - the table the dashboard's Historical
Data view actually renders (45 rows per Paycom client, one per catalog report,
unit_label 'Report'). Not to be confused with historical_data_checklist, which
is the older hand-curated summary table and is NOT what the page reads.

Source of truth: the Drive folder listing on 15 Aug 2026 of
Stave Delivery LLC / Historical Data (1p309L_gSzmGTJv1Ra8OfJRxh9S8-FyLW):

  Prior Payroll History Per Pay Period Wise   4 files
  Time and Attendance Report                 41 files
  HR and Audit Reports                        0 files  (folder exists, empty)

Every file below was seen in that listing - nothing here is inferred. Reports
with no file stay Pending, which is why Time-Off (5), Accrual (4), HR & Audit
(14), E-Verify (2) and Garnishment (1) are untouched: 19 of 45 Received.

Each report keeps ONE row even when several files satisfy it (e.g. a 2025 and a
2026 cut), matching how STAV was seeded with unit_label='Report' throughout.
file_name therefore lists every file that backs that report.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DSP = "STAV"
CHECKED = "2026-08-15"

TA_FOLDER = "https://drive.google.com/drive/folders/1hENO_SK35MKSO0rcluDJLcVlxZzgo68g"
PP_FOLDER = "https://drive.google.com/drive/folders/1A0s0f0Em9laNrK__ZvB6ZyHZTBpGKvs3"

# report_id -> (files, folder_url, notes)
RECEIVED = {
    # --- Time & Attendance: 2025 + 2026 cut of each report -------------------
    6:  (["BreakLunchDuration_2025.xlsx", "BreakLunchDuration_2026.xlsx"], TA_FOLDER, None),
    7:  (["EmployeePunchChange_2025-Q1.csv", "EmployeePunchChange_2025-Q2.csv",
          "EmployeePunchChange_2025-Q3.csv", "EmployeePunchChange_2025-Q4.csv",
          "EmployeePunchChange_2026-Q1.csv", "EmployeePunchChange_2026-Q2.csv",
          "EmployeePunchChange_2026-Q3.xlsx"], TA_FOLDER,
         "Quarterly as the catalog requires: 2025 Q1-Q4 plus 2026 Q1-Q3 to date."),
    8:  (["EmployeeRatesByAllocation_2025.xlsx", "EmployeeRatesByAllocation_2026.xlsx"], TA_FOLDER, None),
    9:  (["HoursWorkedVsThreshold_2025.xlsx", "HoursWorkedVsThreshold_2026.xlsx"], TA_FOLDER, None),
    10: (["LaborAllocation_2025.xlsx", "LaborAllocation_2026.xlsx"], TA_FOLDER, None),
    11: (["LaborAnalysisOvertime_2025.xlsx", "LaborAnalysisOvertime_2026.xlsx"], TA_FOLDER, None),
    12: (["MissedBreakLunch_2025.xlsx", "MissedBreakLunch_2026.xlsx"], TA_FOLDER, None),
    13: (["MissingPunch_2025.xlsx", "MissingPunch_2026.xlsx"], TA_FOLDER, None),
    14: (["PayClassEffectiveDate_2025.xlsx", "PayClassEffectiveDate_2026.xlsx"], TA_FOLDER, None),
    15: (["PunchAudit_2025.xlsx", "PunchAudit_2026.xlsx"], TA_FOLDER, None),
    16: (["PunchesOutsideCurrentAllocation_2025.xlsx",
          "PunchesOutsideCurrentAllocation_2026.xlsx"], TA_FOLDER, None),
    17: (["TimeBetweenShifts_2025.xlsx", "TimeBetweenShifts_2026.xlsx"], TA_FOLDER, None),
    18: (["TimeDetail_2025.xlsx", "TimeDetail_2026.xlsx"], TA_FOLDER, None),
    19: (["TimecardApproval_2025.csv", "TimecardApproval_2026.xlsx"], TA_FOLDER,
         "2025 pulled as CSV, 2026 as XLSX - same report, different export format."),
    20: (["TotalHoursByTimeRange_2025.xlsx", "TotalHoursByTimeRange_2026.xlsx"], TA_FOLDER, None),
    21: (["TotalHoursSummaryByAllocation_2025.xlsx",
          "TotalHoursSummaryByAllocation_2026.xlsx"], TA_FOLDER, None),
    22: (["TotalHoursSummary_2025.xlsx", "TotalHoursSummary_2026.xlsx"], TA_FOLDER, None),
    23: (["ZeroHoursSummary_2025.xlsx", "ZeroHoursSummary_2026.xlsx"], TA_FOLDER, None),
    # --- Payroll -------------------------------------------------------------
    42: (["PriorPayroll_2023.csv", "PriorPayroll_2024.csv", "PriorPayroll_2025.csv",
          "PriorPayroll_2026-to-date.csv"], PP_FOLDER,
         "Delivered as 4 annual cuts (2023-2026 to date) rather than the single "
         "consolidated file the catalog describes - full range is covered."),
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

    print("\nStill Pending (nothing in Drive for these):")
    cur.execute(
        "select c.category, c.report_name from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "where s.dsp_short_code = %s and s.status = 'Pending' order by c.sort_order", (DSP,))
    for category, name in cur.fetchall():
        print(f"  {category:18} {name}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
