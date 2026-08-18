"""Settle the two E-Verify reports for the Paycom clients - opposite outcomes.

Supersedes remove_everify_paycom.py, which assumed Spelman matched Stave. It
did not: checking Drive on 15 Aug 2026 found both E-Verify files sitting in
Spelman's folder. That script was never run; delete it.

STAV (Stave Delivery) - REMOVE both rows.
  Verified in Paycom: Human Resources > E-Verify offers only 'E-Verify
  Training'. No Cases or Case Details export exists, so these can never be
  collected. They are dropped rather than marked 'Not applicable' because the
  dashboard derives the progress bar and the 'complete' state from the row
  count, so a parked row would hold the client permanently short of complete.
  Reason is recorded on historical_scope.notes; rows are backed up first.

SPMA (Spelman Logistics) - mark both RECEIVED.
  Both files are in Spelman's Historical Data, inside a subfolder named
  'Form I-9 Audit Report' rather than an E-Verify folder:
    E-Verify Cases (grid export)   .xlsx, owned by dheeraj.aneja
    EVerifyCaseDetails_2026.csv    .csv,  uploaded 12 Aug
  The Case Details filename says 2026 while the catalog asks for hire dates
  from Jan 1 2023 - flagged in the row's note, not silently accepted as full
  coverage.
"""
import json
import os
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EVERIFY_REPORT_IDS = [43, 44]  # Cases (grid export), Case Details (all cases)

# --- Stave: remove -----------------------------------------------------------
STAV_NOTE = (
    "E-Verify cases does not exist for this client. Verified in Paycom on "
    "15 Aug 2026: Human Resources > E-Verify offers only 'E-Verify Training', "
    "with no Cases or Case Details export. Both E-Verify reports removed from "
    "this client's checklist. (Spelman, the other Paycom client, does have "
    "both - this is per-client, not a Paycom-wide gap.)"
)

# --- Spelman: mark received --------------------------------------------------
SPMA_FOLDER = "https://drive.google.com/drive/folders/1gc_RIcgSeXg8bIsbJ8eGwGGSMDEppHvh"
SPMA_RECEIVED = {
    43: (["E-Verify Cases (grid export)"], SPMA_FOLDER,
         "Filed in the 'Form I-9 Audit Report' subfolder rather than an "
         "E-Verify folder. Owned by dheeraj.aneja."),
    44: (["EVerifyCaseDetails_2026.csv"], SPMA_FOLDER,
         "Filed in the 'Form I-9 Audit Report' subfolder. Filename says 2026 "
         "while the catalog asks for hire dates from Jan 1 2023 - may be a "
         "single-year cut rather than the full consolidated export. Worth a "
         "human check before treating the range as complete."),
}

UPDATE = """
update historical_report_status
   set status = 'Received', file_name = %s, folder_url = %s, notes = %s,
       checked_date = %s, updated_at = now()
 where dsp_short_code = %s and report_id = %s and unit_label = 'Report'
"""

CHECKED = "2026-08-15"
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
BACKUP = os.path.join(DATA_DIR, "removed_everify_rows_STAV.json")


def main():
    conn = connect()
    cur = conn.cursor()

    # ---- Spelman: mark both Received ---------------------------------------
    for report_id, (files, folder, note) in sorted(SPMA_RECEIVED.items()):
        cur.execute(UPDATE, (", ".join(files), folder, note, CHECKED, "SPMA", report_id))
        if cur.rowcount != 1:
            conn.rollback()
            raise SystemExit(f"SPMA report {report_id} matched {cur.rowcount} rows, "
                             "expected 1 - rolled back, nothing written.")
    print("SPMA: 2 E-Verify reports marked Received")

    # ---- Stave: back up, then remove ---------------------------------------
    cur.execute(
        "select * from historical_report_status "
        "where dsp_short_code = 'STAV' and report_id = any(%s)",
        (EVERIFY_REPORT_IDS,))
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    if len(rows) != 2:
        conn.rollback()
        raise SystemExit(f"Found {len(rows)} STAV E-Verify rows, expected 2 - "
                         "rolled back, nothing written.")
    if any(r["status"] == "Received" for r in rows):
        conn.rollback()
        raise SystemExit("A STAV E-Verify row is already 'Received' - real data "
                         "would be lost. Rolled back.")

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(BACKUP, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=2, default=str)
    print(f"STAV: backup written -> {BACKUP}")

    cur.execute(
        "delete from historical_report_status "
        "where dsp_short_code = 'STAV' and report_id = any(%s)",
        (EVERIFY_REPORT_IDS,))
    if cur.rowcount != 2:
        conn.rollback()
        raise SystemExit(f"Deleted {cur.rowcount} STAV rows, expected 2 - rolled back.")

    cur.execute("update historical_scope set notes = %s where dsp_short_code = 'STAV'",
                (STAV_NOTE,))
    if cur.rowcount != 1:
        conn.rollback()
        raise SystemExit("STAV scope note update did not match exactly 1 row - rolled back.")
    print("STAV: 2 E-Verify rows deleted, scope note recorded")

    conn.commit()

    print("\nPaycom clients now:")
    cur.execute(
        "select s.dsp_short_code, "
        "  count(*) filter (where s.status = 'Received'), count(*) "
        "from historical_report_status s "
        "join historical_scope sc on sc.dsp_short_code = s.dsp_short_code "
        "where sc.vendor = 'Paycom' group by s.dsp_short_code order by s.dsp_short_code")
    for code, rec, total in cur.fetchall():
        print(f"  {code}  {rec}/{total}")

    print("\nStill pending on Paycom:")
    cur.execute(
        "select s.dsp_short_code, c.category, c.report_name "
        "from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "join historical_scope sc on sc.dsp_short_code = s.dsp_short_code "
        "where sc.vendor = 'Paycom' and s.status <> 'Received' "
        "order by s.dsp_short_code, c.sort_order")
    for code, category, name in cur.fetchall():
        print(f"  {code}  {category:10} {name}")

    cur.execute("select count(*) filter (where status = 'Received'), count(*) "
                "from historical_report_status")
    got, total = cur.fetchone()
    print(f"\nWhole window: {got} of {total} expected files received")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
