"""One-off: add the four items Rohit listed in chat (17 Aug, 10:00 PM) to
open_items, on Shobhit's explicit instruction.

open_items is hand-curated and the scheduled refresh is barred from touching it.
That guard exists to stop an unattended run clobbering human curation -- it is
not a bar on the owner adding his own items, which is what this is. The
scheduled task's guard is left exactly as it was.

open_items had no owner or due-date column, so both are added here: these four
are assigned work with a deadline, which the existing shape could not express.
"""
import datetime

from supabase_helper import connect

DUE = datetime.date(2026, 8, 19)      # "kal" -- today is 18 Aug 2026
ADDED = datetime.date(2026, 8, 18)
OWNER = "Data Team (Rohit & Shobhit)"
# The dashboard is read by the wider team, so descriptions stay in formal
# English. The original request was raised in Hinglish over chat; it is
# attributed here rather than quoted verbatim.
SRC = "Raised by Rohit Kaushik on 17 Aug 2026."

ITEMS = [
    ("Stave - Emergency contact audit",
     "Run the emergency contact audit for Stave Delivery. " + SRC),
    ("Stave / First Line - documents",
     "Outstanding documents for Stave Delivery and First Line Logistics. " + SRC),
    ("Flash Hub - mail Rachel",
     "Send the Flash Hub mail to Rachel. " + SRC),
    ("Stave - SOC code discussion with Priyanshu",
     "Discuss Stave's SOC code with Priyanshu Sinha. " + SRC),
]


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute("alter table open_items add column if not exists due_date date")
    cur.execute("alter table open_items add column if not exists pending_for text")
    conn.commit()

    added = updated = 0
    for title, desc in ITEMS:
        # Keyed on title so re-running cannot duplicate a hand-curated list.
        # Existing rows have their wording refreshed rather than being skipped,
        # so a correction here actually reaches the dashboard.
        cur.execute("select id, description from open_items where title = %s", (title,))
        row = cur.fetchone()
        if row:
            if row[1] != desc:
                cur.execute("update open_items set description = %s where id = %s",
                            (desc, row[0]))
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
    cur.execute("select count(*) from open_items")
    print("open_items rows now:", cur.fetchone()[0])
    cur.execute("select due_date, severity, pending_for, title from open_items "
                "where due_date is not null order by id")
    print("items carrying a due date:")
    for d, s, p, t in cur.fetchall():
        print("   %s  %-8s  %-28s  %s" % (d, s, p, t))
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
