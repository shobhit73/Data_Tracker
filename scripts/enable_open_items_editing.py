"""Make open_items editable from the dashboard UI instead of only from scripts.

open_items is the one hand-curated table here, and until now the only way to add
an item or close one was to run a script. This opens the browser path: the site's
anon key gets insert + update so the Open Items view can add items, set an
assignee and due date, and mark things done.

Three things worth knowing about the shape of this change:

1. NO DELETE. Adding and closing items needs insert + update only. The site and
   the GitHub repo are both public, so the anon key in the page source is
   readable by anyone -- withholding delete means a stray or malicious caller
   can edit rows but cannot make them disappear. Closing an item is a status
   flip, which stays fully reversible.

2. "Done by" is self-declared. With a public anon key there is no login and so no
   verified identity: completed_by records whatever name the person set in the
   browser. It is an attribution convention for a small internal team, not proof.
   If it ever needs to be trustworthy, the route is Supabase Auth restricted to
   @uzio.com addresses, which would replace this policy set.

3. A backup is written BEFORE the grants go on, so there is always a pre-write
   snapshot of the hand-curated state to restore from.

The scheduled refresh still must not touch this table -- that ban is about
automated imports overwriting hand-curation, and it stands. This change is the
opposite: it gives the humans a faster way in.

Safe to re-run.
"""
import datetime
import json
import os

from supabase_helper import connect

DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
)

DDL = [
    "alter table open_items add column if not exists assignee text",
    "alter table open_items add column if not exists completed_by text",
    "alter table open_items add column if not exists completed_at timestamptz",
    # status was a bare text column defaulting to 'Open'. Constrain it now that
    # the browser writes it, so a typo can never invent a third state that the
    # view's Open/Done split would silently drop.
    "alter table open_items drop constraint if exists open_items_status_check",
    "alter table open_items add constraint open_items_status_check "
    "check (status in ('Open', 'Done'))",
]

# insert + update only, and no delete policy at all -- see note 1 above.
POLICIES = [
    ('drop policy if exists "anon_insert" on open_items', None),
    ('create policy "anon_insert" on open_items for insert to anon with check (true)',
     "insert policy"),
    ('drop policy if exists "anon_update" on open_items', None),
    ('create policy "anon_update" on open_items for update to anon '
     "using (true) with check (true)", "update policy"),
]

GRANTS = [
    "grant insert on open_items to anon, authenticated",
    "grant update on open_items to anon, authenticated",
    # deliberately absent: grant delete
]


def backup(cur):
    """Snapshot the hand-curated rows before any write path opens up."""
    cur.execute("select * from open_items order by id")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    today = datetime.date.today().isoformat()
    path = os.path.join(DATA_DIR, f"open_items_backup_{today}.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, default=str)
    print(f"Backed up {len(rows)} rows -> {os.path.relpath(path, os.path.dirname(DATA_DIR))}")
    return len(rows)


def main():
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()

    backup(cur)

    print("\nSchema:")
    for stmt in DDL:
        cur.execute(stmt)
        print("  ok:", stmt[:72])

    print("\nPolicies:")
    for stmt, label in POLICIES:
        cur.execute(stmt)
        if label:
            print("  ok:", label)

    print("\nGrants:")
    for stmt in GRANTS:
        cur.execute(stmt)
        print("  ok:", stmt)
    print("  (delete deliberately NOT granted)")

    # PostgREST caches the table shape; without this the new columns come back
    # as "column does not exist" from the browser until the API restarts.
    cur.execute("notify pgrst, 'reload schema'")
    print("\nPostgREST schema reload signalled.")

    cur.execute("""
        select grantee, privilege_type
        from information_schema.role_table_grants
        where table_name = 'open_items' and grantee = 'anon'
          and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        order by privilege_type
    """)
    print("anon now holds:", [r[1] for r in cur.fetchall()])

    cur.execute("""
        select column_name from information_schema.columns
        where table_name = 'open_items' order by ordinal_position
    """)
    print("open_items columns:", [r[0] for r in cur.fetchall()])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
