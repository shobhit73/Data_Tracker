"""Same gap as grant_anon_select.py, one role over.

Our tables were created through a raw psycopg2 connection rather than Supabase's
own tooling, so `service_role` never received the grants Supabase hands out to
tables made its way. It was left holding only REFERENCES/TRIGGER/TRUNCATE --
enough to look like a configured role in a grants listing, not enough to read a
single row.

That stayed invisible for months because the browser reads with the anon key,
and anon HAD select (grant_anon_select.py fixed that side, and only that side).
Apps Script taking over Steps 2b and 4c on 06 Oct 2026 was the first consumer to
authenticate as service_role, and it failed on its first call:

    GET api_activity_runs -> HTTP 403 {"code":"42501",
      "message":"permission denied for table api_activity_runs",
      "hint":"Grant the required privileges to the current role with:
              GRANT SELECT ON public.api_activity_runs TO service_role"}

RLS is not involved -- service_role carries rolbypassrls. It was purely the
table grants, which is what the hint says outright. A 403 here means a missing
GRANT, not a wrong key.

WHY WRITES ARE NOT GRANTED EVERYWHERE
    Step 4c only reads; Step 2b writes the three historical tables and nothing
    else. `open_items` and `historical_data_checklist` are hand-curated, and the
    daily refresh task is forbidden from touching them. Leaving them select-only
    puts that rule somewhere a future script cannot talk its way past.

This script is a record of what was applied, and is re-runnable. The grants it
makes were first applied by hand in the Supabase SQL editor on 06 Oct 2026.
"""
from supabase_helper import connect

# Tables Apps Script writes, and the privileges each one actually needs.
#
# client_overview was missed when this file was first written, on the day the
# grants went in: Step 2 had not been ported yet, so only Step 2b's three
# tables were listed. Step 2 landed two days later and failed on its first
# real write with the same 42501 as the original incident. Hence the shape of
# this table -- a new writer means a new row here, and forgetting one fails
# loudly rather than silently.
#
# client_overview gets INSERT and UPDATE but NOT DELETE: the sync only ever
# upserts, so delete would be a privilege nothing uses and a way to lose the
# table to one bad call.
WRITE = {
    # Apps Script, Step 2b
    "historical_scope": "insert, update, delete",
    "historical_report_status": "insert, update, delete",
    "historical_scope_excluded": "insert, update, delete",
    # Apps Script Step 2 (upsert) and the Edge Function's backfill_fein (update)
    "client_overview": "insert, update",
    # The prod-refresh Edge Function. work_locations replaces its table whole,
    # so it is the only one here that needs delete; the rest upsert.
    "client_work_locations": "insert, delete",
    "client_document_counts": "insert, update",
    "api_activity_runs": "insert, update",
    "client_data_coverage": "insert, update",
    "client_system_activity": "insert, update",
    # load_history rebuilds each client's slice rather than merging it -- a
    # stale event row would otherwise survive forever -- so it needs delete.
    "client_load_events": "insert, delete",
}

# Human-owned. Deliberately select-only -- see the module docstring.
NEVER_WRITE = ["open_items", "historical_data_checklist"]

if __name__ == "__main__":
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()

    # Step 4c reads the eight data views, Step 2b reads the catalog. Select is
    # the floor for every table.
    cur.execute("grant usage on schema public to service_role")
    cur.execute("grant select on all tables in schema public to service_role")
    print("granted select on all public tables to service_role")

    for t, privs in WRITE.items():
        assert t not in NEVER_WRITE, f"{t} is human-owned and must stay read-only"
        cur.execute(f"grant {privs} on {t} to service_role")
        print(f"granted {privs} on {t} to service_role")

    # So that a table added later is not a repeat of this whole incident.
    cur.execute("alter default privileges in schema public "
                "grant select on tables to service_role")
    print("default privileges: future tables get select for service_role")

    cur.close()
    conn.close()
