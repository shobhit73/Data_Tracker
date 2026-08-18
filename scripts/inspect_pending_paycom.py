"""Read-only: what is still Pending for each Paycom client, to see whether the
E-Verify gap is Stave-specific or shared. Writes nothing.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main():
    conn = connect()
    cur = conn.cursor()

    cur.execute(
        "select s.dsp_short_code, c.category, c.report_name "
        "from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "join historical_scope sc on sc.dsp_short_code = s.dsp_short_code "
        "where sc.vendor = 'Paycom' and s.status <> 'Received' "
        "order by s.dsp_short_code, c.sort_order"
    )
    for code, category, name in cur.fetchall():
        print(f"  {code}  {category:10} {name}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
