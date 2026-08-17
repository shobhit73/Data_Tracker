"""RLS policies alone aren't enough — Postgres also needs an explicit GRANT
before the anon/authenticated roles can touch a table at all. Our tables were
created via a raw psycopg2 connection (not Supabase's dashboard/migration
tooling), so they never got the anon/authenticated grants Supabase normally
sets up automatically for tables created its own way."""
from supabase_helper import connect

TABLES = [
    "client_overview",
    "client_work_locations",
    "historical_data_checklist",
    "audit_coverage",
    "api_activity_runs",
    "open_items",
    "client_data_coverage",
    "client_load_events",
]

if __name__ == "__main__":
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("grant usage on schema public to anon, authenticated")
    for t in TABLES:
        cur.execute(f"grant select on {t} to anon, authenticated")
        print(f"granted select on {t} to anon, authenticated")
    cur.close()
    conn.close()
