"""Lock down Supabase tables before their anon key goes into public browser JS:
enable RLS on all 6 tables and grant the anon role SELECT-only via policy.
No insert/update/delete policy is created for anon — writes stay confined to
our own scripts, which connect with the postgres role (bypasses RLS)."""
from supabase_helper import connect

TABLES = [
    "client_overview",
    "client_work_locations",
    "historical_data_checklist",
    "audit_coverage",
    "api_activity_runs",
    "open_items",
]

if __name__ == "__main__":
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    for t in TABLES:
        cur.execute(f"alter table {t} enable row level security")
        cur.execute(f'drop policy if exists "anon_read_only" on {t}')
        cur.execute(f'create policy "anon_read_only" on {t} for select to anon using (true)')
        print(f"RLS enabled + read-only policy set on {t}")
    cur.close()
    conn.close()
