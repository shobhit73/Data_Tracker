"""Remove clients from the dashboard's Historical Data section.

Developer-directed (15 Aug 2026): drop CDC Logistics and Trek Delivery from the
Historical Data window. Both sit at 0/20 - nothing was ever collected for them,
so only their seeded 'Pending' rows are lost.

Two tables drive that section and both must be cleaned, or the client vanishes
from the list while its status rows linger as orphans:
  historical_scope          1 row per client  (the "in scope since" window)
  historical_report_status  1 row per catalog report per client

Every row is written to data/removed_historical_scope_<codes>.json before the
delete, so re-seeding is a matter of replaying that file. Nothing else is
touched: audit_coverage, client_overview and historical_data_checklist keep
their CDC/Trek rows, since the ask was scoped to the Historical section.
"""
import json
import os
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

USAGE = ("usage: python remove_historical_scope_clients.py CODE [CODE ...] "
         "--reason \"why they are being dropped\"")

if "--reason" not in sys.argv[1:]:
    raise SystemExit(USAGE + "\n\nThe reason is required: it is the only record of "
                             "why the scope rule is being overridden for these clients.")
_split = sys.argv.index("--reason")
CODES = [c.upper() for c in sys.argv[1:_split]]
REASON = " ".join(sys.argv[_split + 1:]).strip()
if not CODES or not REASON:
    raise SystemExit(USAGE)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
BACKUP = os.path.join(DATA_DIR, f"removed_historical_scope_{'_'.join(CODES)}.json")


def dump(cur, table, where, params):
    cur.execute(f"select * from {table} where {where}", params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def main():
    conn = connect()
    cur = conn.cursor()

    scope = dump(cur, "historical_scope", "dsp_short_code = any(%s)", (CODES,))
    status = dump(cur, "historical_report_status", "dsp_short_code = any(%s)", (CODES,))

    found = {r["dsp_short_code"] for r in scope}
    missing = set(CODES) - found
    if missing:
        raise SystemExit(f"No historical_scope row for {sorted(missing)} - "
                         "check the short codes; nothing written.")

    print(f"scope rows to delete:  {len(scope)}")
    print(f"status rows to delete: {len(status)}")
    for code in CODES:
        n = len([r for r in status if r["dsp_short_code"] == code])
        received = len([r for r in status
                        if r["dsp_short_code"] == code and r["status"] == "Received"])
        print(f"  {code}: {n} status rows, {received} of them 'Received'")
        if received:
            raise SystemExit(
                f"{code} has {received} Received rows - real collected data would be "
                "lost. Aborting; confirm with the developer before removing.")

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(BACKUP, "w", encoding="utf-8") as fh:
        json.dump({"historical_scope": scope, "historical_report_status": status},
                  fh, indent=2, default=str)
    print(f"backup written: {BACKUP}")

    # Record the exclusion BEFORE deleting. Deleting alone does not hold: the
    # scope rule is a live predicate and these clients keep matching it until
    # their last API run ages past SCOPE_DAYS, so the next seed run would put
    # them straight back. seed_historical_reports.refresh_scope checks this
    # table, which is where the human decision lives.
    cur.execute("""
        insert into historical_scope_excluded (dsp_short_code, reason)
        select unnest(%s::text[]), %s
        on conflict (dsp_short_code) do update
          set reason = excluded.reason, excluded_on = current_date, updated_at = now()
    """, (CODES, REASON))
    print(f"exclusions recorded: {cur.rowcount} ({REASON})")

    cur.execute("delete from historical_report_status where dsp_short_code = any(%s)", (CODES,))
    deleted_status = cur.rowcount
    cur.execute("delete from historical_scope where dsp_short_code = any(%s)", (CODES,))
    deleted_scope = cur.rowcount

    if deleted_scope != len(scope) or deleted_status != len(status):
        conn.rollback()
        raise SystemExit("Delete counts did not match the backup - rolled back.")

    conn.commit()
    print(f"deleted {deleted_scope} scope rows, {deleted_status} status rows")

    cur.execute("select count(*) from historical_scope")
    clients = cur.fetchone()[0]
    cur.execute("select count(*) from historical_report_status")
    expected = cur.fetchone()[0]
    cur.execute("select count(*) from historical_report_status where status = 'Received'")
    received = cur.fetchone()[0]
    print(f"\nHistorical window now: {clients} clients, "
          f"{received} of {expected} expected files received")

    cur.execute(
        "select s.dsp_short_code, s.vendor, "
        "  count(*) filter (where st.status = 'Received') as received, count(*) as total "
        "from historical_scope s "
        "join historical_report_status st on st.dsp_short_code = s.dsp_short_code "
        "group by s.dsp_short_code, s.vendor order by s.dsp_short_code")
    for code, vendor, rec, total in cur.fetchall():
        print(f"  {code:5} {vendor:7} {rec}/{total}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
