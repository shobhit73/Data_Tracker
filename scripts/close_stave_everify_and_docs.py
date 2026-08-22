"""Two hand-directed closures for Stave Delivery, both asked for by Shobhit.

1. historical_report_status: the two Paycom E-Verify reports move from Pending
   to 'Not applicable'.

   Grounded in Mercedes Hallback's reply of 19 Aug 2026 15:40 UTC (message
   1a01aae67997efeb, thread 1a019be2ad758d0c): "Client has not used EVerify
   module as it is not a requirement for their state." Open item 23 set this
   out in advance as the correct close-out - no report setting can produce data
   for a module the client never subscribed to, so leaving the rows Pending
   forever would misreport them as outstanding work.

   'Not applicable' is already permitted by the table's status CHECK. The Drive
   scan is monotonic (it only ever writes 'Received'), so it cannot silently
   revert these two rows.

2. open_items 12 narrows to First Line only.

   The item read "Stave / First Line - documents" and covered both clients.
   Stave's half is finished - 9,418 documents against 843 of 1,007 employees,
   reported to Mercedes on 20 Aug 2026. First Line's is NOT: it holds 1
   document across 63 employees and Shobhit confirmed its transfer has not run
   yet. Closing the row outright would have dropped First Line off the board,
   so the row stays Open and is retitled to what actually remains.

   open_items is hand-curated and no scheduled job writes to it. This runs only
   because Shobhit asked for it directly.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EVERIFY_REPORT_IDS = (43, 44)  # 'E-Verify Cases (grid export)', '... Case Details'

EVERIFY_NOTE = (
    "Not applicable - the client never used the E-Verify module. Mercedes "
    "Hallback confirmed on 19 Aug 2026: \"Client has not used EVerify module as "
    "it is not a requirement for their state.\" Raised as open item 23 after the "
    "module could not be found in Paycom at all; the answer makes this an absent "
    "subscription rather than a collection gap, so these two reports are closed "
    "out rather than left Pending."
)

NEW_TITLE = "First Line - documents"

NEW_DESCRIPTION = (
    "Outstanding documents for First Line Logistics. Originally raised by Rohit "
    "Kaushik on 17 Aug 2026 as 'Stave / First Line - documents', covering both "
    "clients. The Stave half is complete: 9,418 documents loaded against 843 of "
    "1,007 employees, summarised to Mercedes Hallback on 20 Aug 2026, and its "
    "remaining gaps (155 leavers terminated before Feb 2022, 9 new hires from "
    "10-18 Aug) are with the client. First Line is untouched - 1 document across "
    "63 employees, its document transfer has not been run yet - so this item "
    "stays open for that half alone."
)


def main():
    conn = connect()
    cur = conn.cursor()

    # --- 1. E-Verify reports -------------------------------------------------
    cur.execute(
        "select s.report_id, c.report_name, s.status, s.unit_label "
        "from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "where s.dsp_short_code = 'STAV' and s.report_id in %s",
        (EVERIFY_REPORT_IDS,))
    before = cur.fetchall()
    print("Before:")
    for r in before:
        print(f"   [{r[0]}] {r[1]}  ->  {r[2]}")

    cur.execute(
        "update historical_report_status "
        "set status = 'Not applicable', notes = %s, updated_at = now() "
        "where dsp_short_code = 'STAV' and report_id in %s",
        (EVERIFY_NOTE, EVERIFY_REPORT_IDS))
    updated = cur.rowcount
    if updated != 2:
        conn.rollback()
        raise SystemExit(f"Expected to update 2 rows, updated {updated} - rolled back.")

    # --- 2. open item 12 -----------------------------------------------------
    cur.execute("select title, status from open_items where id = 12")
    item = cur.fetchone()
    if not item:
        conn.rollback()
        raise SystemExit("open_items 12 not found - rolled back.")
    print(f"\nopen_items 12 before: {item[0]!r} / {item[1]}")

    cur.execute(
        "update open_items set title = %s, description = %s where id = 12",
        (NEW_TITLE, NEW_DESCRIPTION))
    if cur.rowcount != 1:
        conn.rollback()
        raise SystemExit("open_items 12 update touched != 1 row - rolled back.")

    conn.commit()

    # --- verify --------------------------------------------------------------
    cur.execute(
        "select s.report_id, c.report_name, s.status "
        "from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "where s.dsp_short_code = 'STAV' and s.report_id in %s",
        (EVERIFY_REPORT_IDS,))
    print("\nAfter:")
    for r in cur.fetchall():
        print(f"   [{r[0]}] {r[1]}  ->  {r[2]}")

    cur.execute("select status, count(*) from historical_report_status "
                "where dsp_short_code = 'STAV' group by 1 order by 1")
    print("\nSTAV status breakdown now:", cur.fetchall())

    cur.execute("select id, title, status, pending_for from open_items where id = 12")
    print("open_items 12 now:", cur.fetchone())

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
