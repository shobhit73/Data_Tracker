"""Populate client_work_locations for every DSP in client_overview that has a
fein (prod-query, read-only). Joins employer_organization -> emp_work_location
by fein, same pattern as worklocations_lookup.py but writes to Supabase
instead of printing.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pq_helper
from supabase_helper import connect


def fetch_prod_locations(feins):
    inlist = ",".join("'" + f + "'" for f in feins)
    sql = (
        "select replace(coalesce(eo.fein,''),'-','') as fein_norm, "
        "wl.work_location_name, wl.address_line1, wl.address_line2, "
        "wl.city, wl.state, wl.zip_code, wl.primary_location "
        "from employer_organization eo "
        "join emp_work_location wl on wl.employer_organization_id = eo.id "
        "where replace(coalesce(eo.fein,''),'-','') in (" + inlist + ") "
        "and eo.deleted=0 and wl.deleted=0 "
        "order by eo.company_name, wl.primary_location desc, wl.work_location_name"
    )
    jwt = pq_helper.get_jwt()
    status, body = pq_helper.post(
        pq_helper.GATEWAY + "/api/neuronops/query",
        {"sql": sql, "size": 2000},
        {"Authorization": "Bearer " + jwt, "X-Auth-Type": "bearer"},
    )
    if status != 200:
        print("prod-query failed:", status, body)
        sys.exit(1)
    print("prod-query HTTP 200, rows:", len(body["data"]), "hasMore:", body.get("hasMore"))
    return body["data"]


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute("select dsp_short_code, fein from client_overview where fein is not null")
    code_by_fein = {}
    for dsp_short_code, fein in cur.fetchall():
        code_by_fein[fein] = dsp_short_code

    feins = list(code_by_fein.keys())
    print(f"{len(feins)} DSPs with a known fein")

    rows = fetch_prod_locations(feins)

    cur.execute("delete from client_work_locations")  # re-seed cleanly, no natural upsert key
    insert_sql = (
        "insert into client_work_locations "
        "(dsp_short_code, work_location_name, address_line1, address_line2, "
        "city, state, zip_code, is_primary) values (%s,%s,%s,%s,%s,%s,%s,%s)"
    )
    inserted = 0
    unmatched_feins = set(feins)
    for r in rows:
        dsp_short_code = code_by_fein.get(r["fein_norm"])
        if not dsp_short_code:
            continue
        unmatched_feins.discard(r["fein_norm"])
        cur.execute(
            insert_sql,
            (
                dsp_short_code,
                r["work_location_name"],
                r["address_line1"],
                r["address_line2"],
                r["city"],
                r["state"],
                r["zip_code"],
                bool(r["primary_location"]),
            ),
        )
        inserted += 1
    conn.commit()

    print(f"Inserted {inserted} work location rows")
    no_locations = [code_by_fein[f] for f in unmatched_feins]
    if no_locations:
        print(f"{len(no_locations)} DSPs with a fein but no work_location rows in prod: {no_locations}")

    cur.execute("select count(distinct dsp_short_code) from client_work_locations")
    print("Distinct DSPs with at least one location now:", cur.fetchone()[0])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
