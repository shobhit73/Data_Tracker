"""Add the two items raised in the 'Audit Data Request' chat, due 22 Aug,
assigned to Mercedes Hallback.

Both were corroborated against our own tables before writing, so each
description states evidence rather than only repeating the request:

  InnovDel   - historical_data_checklist already reads Timecards 0/3 and Audit
               Trail 0/7 while Payroll History (2023-2025 3/3, 2026 present) and
               Time Off (4/4) are complete. The ADP reports themselves ran fine
               on 08/18 and returned 0 records, so this is "no data in ADP",
               not "report failed".
  High Dist. - historical_data_checklist reads "Not started - No Historical Data
               folder yet" (checked 08/11), and api_activity_runs shows only
               EmployeeCensus has ever run (08/17). Time Tracking went live
               08/16; payroll is due live 08/28.

Severity is set per item rather than uniformly: InnovDel is genuinely waiting on
a client answer (Pending), whereas High Distinction has nothing started at all
with payroll live in nine days (Needs action).

Same conventions as add_workers_comp_items: formal English (the dashboard is
read by the wider team), keyed on title so a re-run cannot duplicate, and
wording is refreshed rather than skipped if it changes.
"""
import datetime

from supabase_helper import connect

DUE = datetime.date(2026, 8, 22)
ADDED = datetime.date(2026, 8, 19)
ASSIGNEE = "Mercedes Hallback"
OWNER = "Implementation"

ITEMS = [
    (
        "Pending",
        "InnovDel - Timecards and Audit Trail not in ADP",
        "Confirm with the client whether ADP holds any timecard data for InnovDel, "
        "and what it is filed under. The four ADP timecard reports run on 08/18 "
        "(06:35-06:46 AM) all completed successfully but returned 0 records, so the "
        "reports are working and the data is absent. Our historical checklist "
        "matches: Timecards 0/3 and Audit Trail 0/7, while Payroll History "
        "(2023-2025 3/3, 2026 present) and Time Off (4/4) are complete. That "
        "pattern points to InnovDel never having used ADP's time and attendance "
        "module rather than a date-range or permission problem, which would mean "
        "no report setting can recover the data. Shruti asked for cuzio to be "
        "included when confirming with the client.",
    ),
    (
        "Needs action",
        "High Distinction - Audit Trail report not found in ADP",
        "The Audit Trail report could not be located in ADP for High Distinction "
        "Logistics. Check first whether a Historical Data folder exists for this "
        "client at all: the historical checklist reads 'Not started - No Historical "
        "Data folder yet' as of 08/11, and the onboarding API tracker shows only "
        "EmployeeCensus has ever run (08/17, by Mercedes). Time Tracking went live "
        "08/16 and payroll is due live 08/28, so the collection window is short. "
        "Treat a missing report as an ADP problem only after the folder and the "
        "collection start are confirmed.",
    ),
]


def main():
    conn = connect()
    cur = conn.cursor()
    added = updated = 0

    for severity, title, desc in ITEMS:
        cur.execute(
            "select id, description, assignee, due_date, severity "
            "from open_items where title = %s", (title,))
        row = cur.fetchone()
        if row:
            if (row[1], row[2], row[3], row[4]) != (desc, ASSIGNEE, DUE, severity):
                cur.execute(
                    "update open_items set description=%s, assignee=%s, due_date=%s, "
                    "severity=%s where id=%s",
                    (desc, ASSIGNEE, DUE, severity, row[0]))
                updated += 1
                print("  updated:", title)
            continue
        cur.execute(
            "insert into open_items (severity, title, description, status, "
            "date_added, due_date, assignee, pending_for) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s)",
            (severity, title, desc, "Open", ADDED, DUE, ASSIGNEE, OWNER))
        added += 1
        print("  added:", title)

    conn.commit()

    print("\nadded %d, updated %d" % (added, updated))
    cur.execute(
        "select due_date, status, severity, coalesce(assignee, pending_for, '-'), title "
        "from open_items order by status, due_date, id")
    print("\nopen_items now:")
    for d, s, sev, who, t in cur.fetchall():
        print("   %s  %-5s  %-13s  %-28s  %s" % (d, s, sev, who, t))
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
