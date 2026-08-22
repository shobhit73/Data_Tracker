"""Mark open item 23 (Stave E-Verify) Done, at Shobhit's direction.

The item existed to carry one question to the client: had they subscribed to
Paycom's E-Verify module, given it could not be found in the UI at all.
Mercedes Hallback answered on 19 Aug 2026 - "Client has not used EVerify module
as it is not a requirement for their state" - and the item's own close-out
condition ("if the answer comes back that the client never subscribed, mark
those two rows Not applicable") has since been carried out: report_ids 43 and
44 for STAV are now 'Not applicable'. Nothing is left waiting on this item.

open_items is hand-curated and no scheduled job writes to it. This runs only
because Shobhit asked for it directly. completed_by is set to his name rather
than left blank, matching what the Open Items form would have written; it is a
self-declared attribution, not an authenticated one.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ITEM_ID = 23
COMPLETED_BY = "Shobhit Sharma"


def main():
    conn = connect()
    cur = conn.cursor()

    cur.execute("select id, title, status, completed_by, completed_at "
                "from open_items where id = %s", (ITEM_ID,))
    before = cur.fetchone()
    if not before:
        raise SystemExit(f"open_items {ITEM_ID} not found.")
    print("Before:", before)

    if before[2] == "Done":
        print("Already Done - nothing to change.")
        cur.close()
        conn.close()
        return

    cur.execute(
        "update open_items set status = 'Done', completed_by = %s, "
        "completed_at = now() where id = %s and status = 'Open'",
        (COMPLETED_BY, ITEM_ID))
    if cur.rowcount != 1:
        conn.rollback()
        raise SystemExit(f"Update touched {cur.rowcount} rows, expected 1 - rolled back.")

    conn.commit()

    cur.execute("select id, title, status, completed_by, completed_at "
                "from open_items where id = %s", (ITEM_ID,))
    print("After: ", cur.fetchone())

    cur.execute("select status, count(*) from open_items group by 1 order by 1")
    print("\nopen_items breakdown:", cur.fetchall())
    cur.execute("select id, title, assignee from open_items where status = 'Open' order by id")
    print("\nStill Open:")
    for r in cur.fetchall():
        print("   ", r)

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
