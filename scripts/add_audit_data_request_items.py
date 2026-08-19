"""The open items raised in the 'Audit Data Request' chat and then escalated by
email on 19 Aug, due 22 Aug.

This script is the single source of truth for these three items: re-running it
re-asserts the current wording, severity and assignee rather than layering a
second script on top. RENAMES carries titles that changed after an item was
first written, so the keyed lookup finds the existing row instead of inserting
a duplicate alongside it.

Each description states evidence checked against our own tables, not just the
request:

  InnovDel   - historical_data_checklist reads Timecards 0/3 and Audit Trail
               0/7 while Payroll History (2023-2025 3/3, 2026 present) and Time
               Off (4/4) are complete. The ADP reports ran fine on 08/18 and
               returned 0 records, so this is "no data in ADP", not "report
               failed".
  High Dist. - historical_data_checklist reads "Not started - No Historical Data
               folder yet" (checked 08/11), and api_activity_runs shows only
               EmployeeCensus has ever run (08/17). Time Tracking went live
               08/16; payroll is due live 08/28.
  First Line - historical_data_checklist reads Payroll History 3/3 for 2023-2025
               with 2026 missing, Time Off 0/4, Timecards 0/3, Audit Trail 0/7,
               I-9 missing. document_transfer still has no row for this client
               and open item 12 ("Stave / First Line - documents") is still
               open, so this sits underneath work already tracked.

All three are now Needs action, which is the top severity the schema allows and
the one the dashboard renders in critical red. Two were raised with the client
by email on 19 Aug, so they are no longer merely noted -- somebody is waiting on
an answer against a live payroll date.

Same conventions as add_workers_comp_items: formal English (the dashboard is
read by the wider team), keyed on title so a re-run cannot duplicate, and
wording is refreshed rather than skipped if it changes.
"""
import datetime

from supabase_helper import connect

DUE = datetime.date(2026, 8, 22)
ADDED = datetime.date(2026, 8, 19)
OWNER = "Implementation"

# old title -> current title, for items retitled after they were first written.
RENAMES = {
    "First Line - ADP document export fails with 400":
        "First Line - ADP historical reports blocked, access requested",
}

# (severity, assignee, title, description)
ITEMS = [
    (
        "Needs action",
        "Mercedes Hallback",
        "InnovDel - Timecards and Audit Trail not in ADP",
        "Raised with the client: email to Mercedes Hallback on 19 Aug 2026, copying "
        "Shruti, Priyanshu and Rohit, asking why no timecard data is in ADP and "
        "listing Timecard Report with Supervisor Approval, Timecard Report with "
        "Notes, and Timecard Exception Report, with a screenshot attached. Now "
        "waiting on the client's answer through Mercedes. "
        "The four ADP timecard reports run on 08/18 (06:35-06:46 AM) all completed "
        "successfully but returned 0 records, so the reports are working and the "
        "data is absent. Our historical checklist matches: Timecards 0/3 and Audit "
        "Trail 0/7, while Payroll History (2023-2025 3/3, 2026 present) and Time Off "
        "(4/4) are complete. That pattern points to InnovDel never having used ADP's "
        "time and attendance module rather than a date-range or permission problem, "
        "which would mean no report setting can recover the data. "
        "Still not raised with the client: the 19 Aug email covered only the three "
        "timecard reports, so Audit Trail (0/7) and I-9 (missing) for this client "
        "remain outstanding and unasked. Shruti asked for cuzio to be included when "
        "confirming with the client.",
    ),
    (
        "Needs action",
        "Mercedes Hallback",
        "High Distinction - Audit Trail report not found in ADP",
        "The Audit Trail report could not be located in ADP for High Distinction "
        "Logistics. Check first whether a Historical Data folder exists for this "
        "client at all: the historical checklist reads 'Not started - No Historical "
        "Data folder yet' as of 08/11, and the onboarding API tracker shows only "
        "EmployeeCensus has ever run (08/17, by Mercedes). Time Tracking went live "
        "08/16 and payroll is due live 08/28, so the collection window is short. "
        "Treat a missing report as an ADP problem only after the folder and the "
        "collection start are confirmed. Unlike InnovDel and First Line, this one "
        "has not yet been raised with the client by email.",
    ),
    (
        "Needs action",
        "Tierra Williams",
        "First Line - ADP historical reports blocked, access requested",
        "Raised with the client: email to Tierra Williams on 19 Aug 2026, copying "
        "Shruti, Priyanshu and Rohit, asking the client for full access to the ADP "
        "account, with screenshots. Five reports listed: Audit Trail (not present), "
        "Employee Lien Detail (returns an error), and the three Timecard reports "
        "- Supervisor Approval, With Notes, and Exception - all not found. Now "
        "waiting on the client's answer through Tierra. "
        "Two things that request does not cover. First, the separate '400 Bad "
        "Request - Request Header Or Cookie Too Large' Rohit hit on ADP Export "
        "Documents: nginx returns that when the browser's headers exceed the "
        "server's size limit, which is accumulated cookies on workforcenow.adp.com, "
        "not a permissions failure. Granting access will not clear it; it needs a "
        "cookie clear or a clean browser profile by whoever hit it. Second, if the "
        "timecard reports turn out to be empty rather than inaccessible, the answer "
        "will be InnovDel's: the client may never have used ADP time and attendance, "
        "and no access grant recovers data that was never recorded. "
        "Historical checklist for this client reads Payroll History 3/3 for "
        "2023-2025 with 2026 missing, Time Off 0/4, Timecards 0/3, Audit Trail 0/7, "
        "I-9 missing. This is also the blocker behind the existing 'Stave / First "
        "Line - documents' item; document_transfer still has no row for this client.",
    ),
]


def main():
    conn = connect()
    cur = conn.cursor()
    renamed = added = updated = 0

    for old_title, new_title in RENAMES.items():
        cur.execute("select id from open_items where title = %s", (new_title,))
        if cur.fetchone():
            continue  # already renamed on an earlier run
        cur.execute(
            "update open_items set title = %s where title = %s",
            (new_title, old_title))
        if cur.rowcount:
            renamed += 1
            print("  renamed: %r -> %r" % (old_title, new_title))

    for severity, assignee, title, desc in ITEMS:
        cur.execute(
            "select id, description, assignee, due_date, severity "
            "from open_items where title = %s", (title,))
        row = cur.fetchone()
        if row:
            if (row[1], row[2], row[3], row[4]) != (desc, assignee, DUE, severity):
                cur.execute(
                    "update open_items set description=%s, assignee=%s, due_date=%s, "
                    "severity=%s where id=%s",
                    (desc, assignee, DUE, severity, row[0]))
                updated += 1
                print("  updated:", title)
            continue
        cur.execute(
            "insert into open_items (severity, title, description, status, "
            "date_added, due_date, assignee, pending_for) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s)",
            (severity, title, desc, "Open", ADDED, DUE, assignee, OWNER))
        added += 1
        print("  added:", title)

    conn.commit()

    print("\nrenamed %d, added %d, updated %d" % (renamed, added, updated))
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
