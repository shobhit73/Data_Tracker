"""Load data/matrix_raw.tsv into api_activity_runs. Nothing else.

Deliberately NOT populate_remaining_tables.py: that script also rewrites
historical_data_checklist (human-owned, never scripted) and audit_coverage
(which now tracks Rohit's daily mail and would be clobbered back to its
original seed). This does the api_activity_runs third of it and stops.

Reads through gen_matrix, so the client list, the vendor-per-FEIN vote and the
displayed-module list all stay defined in exactly one place. Run
rebuild_matrix_raw.py first when a new export lands on PHIX-72859.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

UPSERT = """
insert into api_activity_runs
  (fein, client_name, vendor, module_key, last_run_date, run_by)
values (%s, %s, %s, %s, %s, %s)
on conflict (fein, module_key) do update set
  client_name = excluded.client_name,
  vendor = excluded.vendor,
  last_run_date = excluded.last_run_date,
  run_by = excluded.run_by,
  updated_at = now()
"""


def main():
    import gen_matrix  # top-level code reads matrix_raw.tsv and votes on vendors

    conn = connect()
    cur = conn.cursor()

    cur.execute("select fein, module_key, last_run_date, run_by from api_activity_runs")
    before = {(r[0], r[1]): (str(r[2]), r[3]) for r in cur.fetchall()}

    rows, changes = [], []
    for fein, name in gen_matrix.clients:
        vendor = gen_matrix.client_vendor[fein]
        for module_key, _label in gen_matrix.MODULES:
            cell = gen_matrix.data.get(fein, {}).get(module_key)
            if not cell:
                continue
            last, by = cell
            rows.append((fein, name, vendor, module_key, last, by))

            prev = before.get((fein, module_key))
            if prev is None:
                changes.append(f"ADDED   {name:32} {module_key:24} {last} {by}")
            elif prev != (last, by):
                changes.append(f"UPDATED {name:32} {module_key:24} "
                               f"{prev[0]} {prev[1]} -> {last} {by}")

    for r in rows:
        cur.execute(UPSERT, r)
    conn.commit()

    print(f"{len(rows)} rows upserted into api_activity_runs")
    if changes:
        print(f"\n{len(changes)} changed:")
        for line in changes:
            print("  " + line)
    else:
        print("\nno changes - every row already matched matrix_raw.tsv")

    cur.execute("select count(*), max(last_run_date) from api_activity_runs")
    total, newest = cur.fetchone()
    print(f"\napi_activity_runs: {total} rows, most recent run {newest}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
