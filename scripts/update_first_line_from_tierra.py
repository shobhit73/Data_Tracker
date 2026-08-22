"""Close out First Line Logistics' (FILI) outstanding historical reports.

Source: Tierra Williams' reply of 20 Aug 2026 on the thread "Issues in
Historical Data - First Line Logistics" (thread 1a01967f36f9dc77, message
1a01faad40188c07). The five reports I had raised on 19 Aug came back as:

    1. Audit Trail Report                       - not present
    2. Employee Lien Detail Report              - no report, no lien on employees
    3. Timecard Report with Supervisor Approval - attached in email
    4. Timecard Report with Notes               - no notes with report
    5. Timecard Exception Report                - attached in email

Two of those are files (3, 5) and were uploaded to the client's Historical Data
folder on 22 Aug; three are absences (1, 2, 4). The absences are recorded as
'Not applicable', NOT left Pending, because Pending means "nobody has fetched
this yet" and would keep the client showing an open collection gap forever
against reports that cannot be produced.

The I-9 row is also closed here. It is not in Tierra's mail - the file has been
sitting in the folder since 19 Aug and the row simply never got marked, which a
folder listing on 22 Aug confirmed.

Every file_name below was read off a live Drive listing of folder
1EVssu_HklpP9hu8dEoCcj1_yFKG_F8qh, not off the mail, so a name that was changed
on upload is the name recorded here.

Idempotent: re-running rewrites the same values. It is scoped to FILI and to
the report ids listed, and it does not touch the eight rows already Received.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CODE = "FILI"
CHECKED = "2026-08-22"
FOLDER = "https://drive.google.com/drive/folders/1EVssu_HklpP9hu8dEoCcj1_yFKG_F8qh"

MAIL = ("Tierra Williams, 20 Aug 2026, thread 'Issues in Historical Data - "
        "First Line Logistics'")

# (report_id, unit_label, status, file_name, notes)
ROWS = [
    # --- arrived -------------------------------------------------------
    (51, "Report", "Received", "Timecard Report with Supervisor Approval (2).csv",
     "Attached to " + MAIL + " and uploaded to the Historical Data folder on "
     "22 Aug 2026. Originally reported 'not found' on 19 Aug - it needed the "
     "client's own ADP access, which is what the thread was chasing."),
    (53, "Report", "Received", "Timecard Exception Report.csv",
     "Attached to " + MAIL + " and uploaded to the Historical Data folder on "
     "22 Aug 2026. Same access story as the supervisor-approval report."),
    # Not in Tierra's mail: the file has been in the folder since 19 Aug 2026
    # and the row was simply never marked. Confirmed by a Drive listing on
    # 22 Aug 2026.
    (55, "Report", "Received",
     "First Line Logistics Form I-9 and E-Verify Information.xlsx",
     "Present in the Historical Data folder since 19 Aug 2026; the row had "
     "stayed Pending because no scan had been run over this client since. "
     "Confirmed by a Drive listing of the folder on 22 Aug 2026."),

    # --- cannot exist --------------------------------------------------
    # Marked 'Not applicable' rather than Pending: there is nothing to collect,
    # so a Pending row would misreport a closed question as an open gap.
    (52, "Report", "Not applicable", None,
     "Not applicable - " + MAIL + ": \"Timecard Report with Notes - no notes "
     "with report\". The report exists in ADP but carries no notes for this "
     "client, so there is no file to collect. Not a gap."),
    (56, "Report", "Not applicable", None,
     "Not applicable - " + MAIL + ": \"Employee Lien Detail Report - no "
     "report, no lien on employees\". No employee of this client has a lien or "
     "garnishment, so ADP produces no report. On 19 Aug this looked like a "
     "fault - pulling it returned an error - which is what that error means."),
]

# Audit Trail is quarterly, so all seven in-scope units close together: the
# report is absent for the client as a whole, not for particular quarters.
#
# JUDGEMENT CALL, flagged rather than buried: Tierra's reply says only "not
# present", with no reason - unlike the lien and notes rows, which explain
# themselves. Both my 19 Aug mail (checking ADP myself) and her 20 Aug reply
# (with the client's access) reached the same answer, so this is recorded as
# Not applicable. If it later turns out ADP does hold an audit trail for this
# client and it was merely not visible, these seven rows must be reopened by
# hand - the scan will not do it, by design.
AUDIT_TRAIL_UNITS = ["2025 Q1", "2025 Q2", "2025 Q3", "2025 Q4",
                     "2026 Q1", "2026 Q2", "2026 Q3"]
AUDIT_TRAIL_NOTE = (
    "Not applicable - " + MAIL + ": \"Audit Trail Report - not present\". "
    "Confirmed twice: not found in ADP on 19 Aug 2026, and confirmed absent by "
    "the implementer with client access on 20 Aug. No reason was given for why "
    "the report does not exist, so if that changes these rows should be "
    "reopened by hand."
)

UPDATE = """
update historical_report_status
   set status = %s,
       checked_date = %s,
       file_name = %s,
       folder_url = %s,
       notes = %s,
       updated_at = now()
 where dsp_short_code = %s and report_id = %s and unit_label = %s
"""


def main():
    conn = connect()
    cur = conn.cursor()

    cur.execute(
        "select report_id, unit_label, status from historical_report_status "
        "where dsp_short_code = %s", (CODE,))
    before = {(r[0], r[1]): r[2] for r in cur.fetchall()}

    rows = list(ROWS) + [
        (54, unit, "Not applicable", None, AUDIT_TRAIL_NOTE)
        for unit in AUDIT_TRAIL_UNITS
    ]

    changes, missing = [], []
    for rid, unit, status, fname, notes in rows:
        # A Received row keeps its folder link; an N/A row has no file, so it
        # gets none - a link there would imply something is sitting in Drive.
        folder = FOLDER if status == "Received" else None
        cur.execute(UPDATE, (status, CHECKED, fname, folder, notes,
                             CODE, rid, unit))
        if cur.rowcount == 0:
            # No such row: the catalogue and the status table have drifted.
            # Say so instead of quietly doing nothing.
            missing.append((rid, unit))
            continue
        prev = before.get((rid, unit))
        label = f"{rid} [{unit}]"
        if prev != status:
            changes.append(f"  {label:14s} {prev} -> {status}")
        else:
            changes.append(f"  {label:14s} {status} (re-confirmed)")

    conn.commit()

    print(f"{CODE} historical rows written from the {CHECKED} check:")
    for line in changes:
        print(line)
    if missing:
        print("\n!! no such row - catalogue/status drift, nothing written:")
        for rid, unit in missing:
            print(f"   report_id={rid} unit_label={unit!r}")

    cur.execute(
        "select status, count(*) from historical_report_status "
        "where dsp_short_code = %s group by 1 order by 2 desc", (CODE,))
    print("\nFILI status breakdown now:", cur.fetchall())

    cur.execute(
        "select count(*) from historical_report_status "
        "where dsp_short_code = %s and status = 'Pending'", (CODE,))
    print("still Pending:", cur.fetchone()[0])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
