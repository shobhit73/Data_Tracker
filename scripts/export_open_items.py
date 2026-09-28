"""Export every open_items row to data/open_items_backup_<date>.json.

Phase 1 of the CRM merge (docs/plans/2026-09-28-phase1-open-items-to-crm.md):
this file is both the migration input for crm-merge/import_open_items.py and
the permanent backup taken before the table is locked. Re-running on the same
day overwrites that day's file with a fresh dump — which is the point.
"""
import datetime
import json
import os

from supabase_helper import connect

BACKUP_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute("select * from open_items order by id")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.date.today().isoformat()
    path = os.path.join(BACKUP_DIR, "open_items_backup_%s.json" % stamp)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False, default=str)

    by_status = {}
    for r in rows:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    print("exported %d rows (%s) -> %s" % (
        len(rows),
        ", ".join("%d %s" % (n, s) for s, n in sorted(by_status.items())),
        path))


if __name__ == "__main__":
    main()
