"""Close out Historical Accrual Data (report 27) for both Paycom clients.

Developer-directed on 15 Aug 2026. This report comes back empty by nature, so
it is treated as satisfied once pulled rather than chased for content.

The two clients are NOT in the same evidence position, and the notes say so:

  SPMA - a real file exists. 'Historical Accural Data Report.xlsx' (4 KB,
         uploaded 6 Aug) sits in Spelman's 'Accural Reports' subfolder. Both
         the folder and the file carry the vendor's 'Accural' misspelling;
         recorded verbatim so a later Drive search still matches.

  STAV - NO file in Drive. Stave's Accrual subfolder was re-listed at the time
         of writing and holds only AccrualBalances, AccrualDetail 2025/2026 and
         AccrualSummary 2025/2026. Marked Received on the developer's
         instruction because the report is empty when pulled; file_name and
         folder_url are deliberately left NULL rather than pointing at a file
         that is not there. If evidence is ever required, this row is the one
         to revisit.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPORT_ID = 27  # Accrual / Historical Accrual Data
CHECKED = "2026-08-15"

SPMA_FOLDER = "https://drive.google.com/drive/folders/1grI7CG4b0zDUt9gO_iFuBO1r_KtVNQ9G"

TARGETS = {
    "SPMA": {
        "file_name": "Historical Accural Data Report.xlsx",
        "folder_url": SPMA_FOLDER,
        "notes": "4 KB file in the 'Accural Reports' subfolder, uploaded 6 Aug 2026. "
                 "This report is empty by nature - the small size is expected, not a "
                 "failed pull. Folder and file both use the vendor's 'Accural' "
                 "misspelling.",
    },
    "STAV": {
        "file_name": None,
        "folder_url": None,
        "notes": "Marked received on developer instruction (15 Aug 2026): this report "
                 "returns empty for every client, so it is not chased. NO file was "
                 "present in Stave's Accrual subfolder at the time of marking - that "
                 "folder held only AccrualBalances, AccrualDetail 2025/2026 and "
                 "AccrualSummary 2025/2026. file_name and folder_url left blank on "
                 "purpose: nothing to point at.",
    },
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

    for code, vals in TARGETS.items():
        cur.execute(UPDATE, (vals["file_name"], vals["folder_url"], vals["notes"],
                             CHECKED, code, REPORT_ID))
        if cur.rowcount != 1:
            conn.rollback()
            raise SystemExit(f"{code} report {REPORT_ID} matched {cur.rowcount} rows, "
                             "expected 1 - rolled back, nothing written.")
        print(f"{code}: Historical Accrual Data marked Received")

    conn.commit()

    print("\nPaycom clients now:")
    cur.execute(
        "select s.dsp_short_code, "
        "  count(*) filter (where s.status = 'Received'), count(*) "
        "from historical_report_status s "
        "join historical_scope sc on sc.dsp_short_code = s.dsp_short_code "
        "where sc.vendor = 'Paycom' group by s.dsp_short_code order by s.dsp_short_code")
    for code, rec, total in cur.fetchall():
        flag = "  <- complete" if rec == total else ""
        print(f"  {code}  {rec}/{total}{flag}")

    cur.execute(
        "select s.dsp_short_code, c.report_name from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "join historical_scope sc on sc.dsp_short_code = s.dsp_short_code "
        "where sc.vendor = 'Paycom' and s.status <> 'Received'")
    remaining = cur.fetchall()
    print("\nStill pending on Paycom:", remaining if remaining else "none")

    cur.execute("select count(*) filter (where status = 'Received'), count(*) "
                "from historical_report_status")
    got, total = cur.fetchone()
    print(f"\nWhole window: {got} of {total} expected files received")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
