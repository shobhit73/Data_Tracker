"""Remove the standing observations from open_items, on Shobhit's instruction
("baki saare open items hata do, koi relevant nahi hai").

Scope: rows with no due_date -- the ten hand-written observations. The four
assigned items carry a due date and are left alone.

The table is hand-curated and this is irreversible, so every row is written to
data/open_items_backup_<date>.json first. Several of the ten had in fact been
overtaken by work done since they were written -- the Lazo Q2-2026 Audit Trail
they flag as missing has since been received, and "employee headcount per client
not sourced" is now answered by client_data_coverage -- so this is mostly a
clear-out of items that had already resolved themselves.
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

    cur.execute("select * from open_items where due_date is null order by id")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    if not rows:
        print("nothing to remove — no undated open items")
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.date.today().isoformat()
    path = os.path.join(BACKUP_DIR, "open_items_backup_%s.json" % stamp)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False, default=str)

    print("backed up %d rows to %s" % (len(rows), path))
    for r in rows:
        print("   [%s] %s" % (r.get("severity"), r.get("title")))

    ids = [r["id"] for r in rows]
    cur.execute("delete from open_items where id = any(%s)", (ids,))
    removed = cur.rowcount
    conn.commit()

    cur.execute("select count(*) from open_items")
    left = cur.fetchone()[0]
    print("\nremoved %d, %d rows left" % (removed, left))
    cur.execute("select title, due_date, pending_for from open_items order by id")
    for t, d, p in cur.fetchall():
        print("   %s  %-28s  %s" % (d, p, t))

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
