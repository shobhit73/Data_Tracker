"""Per-client load history: when employees were added or terminated, by whom.

WHY THIS EXISTS
    api_activity_runs records one last_run_date per module. That single date
    hides the shape of the load: Stave's census log says 08 Aug, but 982 of its
    989 employees landed on 29 Jul and only 7 came on the 8th. Trying to infer
    the "real" run date from prod got to 69-76% agreement and no further (see
    the rule bake-off in the session notes) -- the honest fix is not a better
    guess, it is showing the whole history and letting a person read it.

    With this, API coverage can be cross-checked from the dashboard: if the log
    claims a census ran but no batch of employees ever appeared, the claim is
    wrong, and the reverse is just as visible.

WHO THE ACTOR IS
    employee.created_by is an email for Uzio staff (mercedes.hallback1@uzio.com
    -- the same handle api_activity_runs stores in run_by, minus the domain),
    the literal 'SYSTEM' for API/system writes, and a UUID for client-side
    users. The UUIDs are resolved back to real usernames through user_data, so
    "who added these" answers with a person rather than a hex string.

Run:  python populate_load_history.py
Writes only client_load_events. Never touches open_items or
historical_data_checklist (human-owned), nor api_activity_runs (manual).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pq_helper
from supabase_helper import connect

DDL = """
create table if not exists client_load_events (
  dsp_short_code text not null,
  event_date date not null,
  kind text not null,
  actor text,
  actor_type text,
  employees integer,
  updated_at timestamptz default now(),
  primary key (dsp_short_code, event_date, kind, actor)
)
"""

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-", re.I)


def pq(sql, size=5000):
    jwt = pq_helper.get_jwt()
    status, body = pq_helper.post(
        pq_helper.GATEWAY + "/api/neuronops/query",
        {"sql": sql, "size": size},
        {"Authorization": "Bearer " + jwt, "X-Auth-Type": "bearer"},
    )
    if status != 200:
        print("prod-query failed:", status, str(body)[:400])
        sys.exit(1)
    if body.get("hasMore"):
        print("WARNING: result truncated at", size, "rows -- raise the page size")
    return body["data"]


def fetch_added(feins):
    """One row per (employer, day, actor) for employees created."""
    inlist = ",".join("'" + f + "'" for f in feins)
    return pq(
        "select replace(coalesce(eo.fein,''),'-','') as fein_norm, "
        "cast(e.created_date as date) as event_date, "
        "e.created_by as actor, count(*) as employees "
        "from employer_organization eo "
        "join employee e on e.employer_organization_id = eo.id and e.deleted = 0 "
        "where eo.deleted = 0 and e.created_date is not null "
        "and replace(coalesce(eo.fein,''),'-','') in (" + inlist + ") "
        "group by 1,2,3"
    )


def fetch_terminated(feins):
    """Departures per (employer, day) -- no actor.

    Two deliberate narrowings. terminated_by is a numeric user id, not the
    email created_by carries, and "who terminated them" is not the question
    this view answers, so it is dropped rather than half-resolved. And only
    terminations dated on or after the client's first load are counted: the
    census imports the client's whole ADP/Paycom history, so without this the
    chart shows departures going back to 2018 (19,159 client-day pairs) that
    predate Uzio ever holding the client. Scoped, it is 1,609 pairs from the
    point migration actually began.
    """
    inlist = ",".join("'" + f + "'" for f in feins)
    return pq(
        "select replace(coalesce(eo.fein,''),'-','') as fein_norm, "
        "cast(e.date_of_termination as date) as event_date, "
        "count(*) as employees "
        "from employer_organization eo "
        "join employee e on e.employer_organization_id = eo.id and e.deleted = 0 "
        "join (select employer_organization_id as oid, "
        "        min(cast(created_date as date)) as first_load "
        "      from employee where deleted = 0 group by 1) f on f.oid = eo.id "
        "where eo.deleted = 0 and e.date_of_termination is not null "
        "and e.date_of_termination >= f.first_load "
        "and replace(coalesce(eo.fein,''),'-','') in (" + inlist + ") "
        "group by 1,2"
    )


def resolve_actors(raw_actors):
    """UUID actors are client-side logins; map them to usernames so the chart
    can name a person. Anything that will not resolve keeps a generic label
    rather than showing a hex string to the reader."""
    uuids = sorted({a for a in raw_actors
                    if isinstance(a, str) and UUID_RE.match(a)})
    if not uuids:
        return {}
    resolved = {}
    # chunked: the identifier list goes into an IN clause
    for i in range(0, len(uuids), 200):
        chunk = uuids[i:i + 200]
        inlist = ",".join("'" + u + "'" for u in chunk)
        for row in pq(
            "select user_identifier, username from user_data "
            "where user_identifier in (" + inlist + ")"
        ):
            resolved[row["user_identifier"]] = row["username"]
    return resolved


def classify(actor, resolved):
    if actor is None or actor == "":
        return "-", "n/a"
    if not isinstance(actor, str):
        return str(actor), "other"
    if actor == "SYSTEM":
        return "SYSTEM", "system"
    if actor.endswith("@uzio.com"):
        # strip the domain so it matches api_activity_runs.run_by exactly
        return actor[: -len("@uzio.com")], "staff"
    if UUID_RE.match(actor):
        return resolved.get(actor, "Client user"), "client"
    return actor, "other"


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute(DDL)
    conn.commit()

    cur.execute(
        "select dsp_short_code, fein from client_overview where fein is not null")
    code_by_fein = {fein: code for code, fein in cur.fetchall()}
    print(f"{len(code_by_fein)} DSPs with a fein")

    all_rows = []
    for kind, fetch in (("added", fetch_added), ("terminated", fetch_terminated)):
        rows = fetch(list(code_by_fein))
        print(f"  {kind:11s}: {len(rows)} rows from prod")
        for r in rows:
            r["kind"] = kind
            r.setdefault("actor", None)   # terminations carry no actor
        all_rows += rows

    resolved = resolve_actors({r["actor"] for r in all_rows})
    print(f"resolved {len(resolved)} client-side UUIDs to usernames")

    # Fully derived data, so the client's slice is rebuilt rather than merged --
    # a stale event row would otherwise survive forever.
    codes = sorted({code_by_fein[r["fein_norm"]] for r in all_rows
                    if r["fein_norm"] in code_by_fein})
    cur.execute("delete from client_load_events where dsp_short_code = any(%s)", (codes,))
    deleted = cur.rowcount

    written = 0
    merged = {}
    for r in all_rows:
        code = code_by_fein.get(r["fein_norm"])
        if not code:
            continue
        actor, atype = classify(r["actor"], resolved)
        # two raw actors can normalise to one label (e.g. two unresolved UUIDs),
        # so sum instead of letting the primary key reject the second row
        key = (code, str(r["event_date"])[:10], r["kind"], actor)
        if key in merged:
            merged[key][0] += int(r["employees"])
        else:
            merged[key] = [int(r["employees"]), atype]

    for (code, day, kind, actor), (n, atype) in merged.items():
        cur.execute(
            "insert into client_load_events "
            "(dsp_short_code, event_date, kind, actor, actor_type, employees) "
            "values (%s,%s,%s,%s,%s,%s)",
            (code, day, kind, actor, atype, n))
        written += 1
    conn.commit()

    print(f"client_load_events: deleted {deleted}, inserted {written}")

    cur.execute(
        "select kind, count(*), sum(employees) from client_load_events group by 1 order by 1")
    for kind, n, emp in cur.fetchall():
        print(f"  {kind:11s} {n:5d} events  {emp:7d} employees")

    cur.execute(
        "select actor_type, count(*), sum(employees) from client_load_events "
        "where kind='added' group by 1 order by 3 desc")
    print("  who added them:")
    for atype, n, emp in cur.fetchall():
        print(f"    {str(atype):8s} {n:5d} events  {emp:7d} employees")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
