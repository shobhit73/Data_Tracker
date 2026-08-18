"""Add the four Workers' Compensation items to open_items, due 19 Aug.

Corroborated before writing: api_activity_runs shows every other onboarding
module has run for these four clients, and WorkerCompensation has run for none
of them. So the ask matches the data rather than only the request.

Same conventions as add_rohit_items: formal English (the dashboard is read by
the wider team), keyed on title so a re-run cannot duplicate, and wording is
refreshed rather than skipped if it changes.
"""
import datetime

from supabase_helper import connect

DUE = datetime.date(2026, 8, 19)
ADDED = datetime.date(2026, 8, 18)
OWNER = "Data Team (Rohit & Shobhit)"
NOTE = ("No WorkerCompensation run recorded in the onboarding API tracker, "
        "while every other module has run for this client.")

ITEMS = [
    ("InnovDel - Workers Comp", "Workers' Compensation setup for InnovDel. " + NOTE),
    ("First Line - Workers Comp", "Workers' Compensation setup for First Line Logistics. " + NOTE),
    ("Flash Hub - Workers Comp", "Workers' Compensation setup for Flash Hub Delivery. " + NOTE),
    ("Stave Delivery - Workers Comp", "Workers' Compensation setup for Stave Delivery. " + NOTE),
]


def main():
    conn = connect()
    cur = conn.cursor()
    added = updated = 0
    for title, desc in ITEMS:
        cur.execute("select id, description from open_items where title = %s", (title,))
        row = cur.fetchone()
        if row:
            if row[1] != desc:
                cur.execute("update open_items set description=%s where id=%s", (desc, row[0]))
                updated += 1
                print("  reworded:", title)
            continue
        cur.execute(
            "insert into open_items (severity, title, description, status, "
            "date_added, due_date, pending_for) values (%s,%s,%s,%s,%s,%s,%s)",
            ("Pending", title, desc, "Open", ADDED, DUE, OWNER))
        added += 1
        print("  added:", title)
    conn.commit()

    print("\nadded %d, reworded %d" % (added, updated))
    cur.execute("select due_date, pending_for, title from open_items order by due_date, id")
    print("open_items now:")
    for d, p, t in cur.fetchall():
        print("   %s  %-28s  %s" % (d, p, t))
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
