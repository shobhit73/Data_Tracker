"""Lock open_items: the table moved to Rohit's CRM on 2026-09-28.

Phase 1 close-out (docs/plans/2026-09-28-phase1-open-items-to-crm.md). All 12
rows were exported to data/open_items_backup_2026-09-28.json; 10 became ad-hoc
tasks in the CRM (tasks #1571-1580), the 2 Flash Hub ones are archived in the
backup only. From now on items live in the CRM (crm-teal-chi-45.vercel.app),
under login + RLS.

This reverses enable_open_items_editing.py: the anon insert/update policies and
grants go away, SELECT stays so the old dashboard still renders the historical
list read-only. The table itself is kept as a second archive, not dropped.
"""
from supabase_helper import connect

STMTS = [
    'drop policy if exists "anon_insert" on open_items',
    'drop policy if exists "anon_update" on open_items',
    "revoke insert on open_items from anon, authenticated",
    "revoke update on open_items from anon, authenticated",
]


def main():
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    for stmt in STMTS:
        cur.execute(stmt)
        print("ok:", stmt)

    cur.execute("""
        select grantee, privilege_type
        from information_schema.role_table_grants
        where table_name = 'open_items' and grantee in ('anon', 'authenticated')
        order by grantee, privilege_type
    """)
    print("\nremaining grants on open_items:")
    for g in cur.fetchall():
        print("  %-14s %s" % g)
    cur.execute("select polname from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = 'open_items'")
    print("remaining policies:", [r[0] for r in cur.fetchall()])


if __name__ == "__main__":
    main()
