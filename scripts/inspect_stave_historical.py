"""Read-only: the Paycom catalog, Stave's scope row, Stave's per-report status,
and one already-populated client for comparison. Writes nothing.
"""
import sys

from supabase_helper import connect

# Some catalog/notes text carries non-cp1252 characters (arrows, dashes); the
# Windows console would otherwise raise UnicodeEncodeError mid-dump.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main():
    conn = connect()
    cur = conn.cursor()

    print("=" * 78)
    print("historical_scope rows")
    cur.execute("select * from historical_scope order by dsp_short_code")
    for row in cur.fetchall():
        print("  ", row)

    print("=" * 78)
    print("Paycom catalog")
    cur.execute(
        "select id, category, report_name, year_range, unit_type, sort_order "
        "from historical_report_catalog where vendor = 'Paycom' order by sort_order"
    )
    for row in cur.fetchall():
        print("  ", row)

    print("=" * 78)
    print("status vocabulary in use")
    cur.execute("select status, count(*) from historical_report_status group by 1 order by 2 desc")
    print("  ", cur.fetchall())

    print("=" * 78)
    print("Stave (STAV) status rows")
    cur.execute(
        "select s.report_id, c.report_name, s.unit_label, s.status, s.file_count, "
        "s.checked_date, s.file_name "
        "from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "where s.dsp_short_code = 'STAV' order by c.sort_order, s.unit_label"
    )
    rows = cur.fetchall()
    print(f"  ({len(rows)} rows)")
    for row in rows:
        print("  ", row)

    print("=" * 78)
    print("A populated client for comparison - rows that are NOT Pending")
    cur.execute(
        "select s.dsp_short_code, c.report_name, s.unit_label, s.status, s.file_count, "
        "s.file_name, s.folder_url "
        "from historical_report_status s "
        "join historical_report_catalog c on c.id = s.report_id "
        "where s.status <> 'Pending' order by s.dsp_short_code, c.sort_order limit 25"
    )
    for row in cur.fetchall():
        print("  ", row)

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
