"""Backfill client_overview.fein by matching Shruti's DSP names against
prod employer_organization (read-only prod-query, via pq_helper).

Matching strategy: normalize both sides (uppercase, strip punctuation, drop
common legal suffixes like LLC/INC/CORP) and match exact-on-normalized.
Anything left unmatched is reported, not guessed.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pq_helper
from supabase_helper import connect

SUFFIXES = r"\b(LLC|L L C|INC|CORP|CORPORATION|CO|LTD|LP)\.?\b"


def normalize(name):
    n = (name or "").upper()
    n = re.sub(r"[.,]", " ", n)
    n = re.sub(SUFFIXES, " ", n)
    n = re.sub(r"[^A-Z0-9 ]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


def fetch_prod_dsp_orgs():
    """Same request pq_helper.run() would make, but without its per-row stdout dump
    (bulk fetch here can be 100s of rows — printing each would flood the terminal)."""
    sql = (
        "select company_name, company_identifier, "
        "replace(coalesce(fein,''),'-','') as fein_norm, live_status "
        "from employer_organization "
        "where deleted=0 and company_identifier like 'DSP%' "
        "order by company_name"
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
    rows = body["data"]
    print("prod-query HTTP 200, rows:", len(rows), "hasMore:", body.get("hasMore"))
    if body.get("hasMore"):
        print("WARNING: more than 2000 DSP-tagged orgs in prod — pagination not implemented, results truncated")
    return rows


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute("select dsp_short_code, dsp_name from client_overview where fein is null")
    targets = cur.fetchall()
    print(f"{len(targets)} DSPs in client_overview still missing fein")

    prod_rows = fetch_prod_dsp_orgs()
    print(f"{len(prod_rows)} DSP-tagged orgs found in prod")

    prod_by_norm = {}
    for r in prod_rows:
        key = normalize(r["company_name"])
        prod_by_norm.setdefault(key, []).append(r)

    matched, ambiguous, unmatched = [], [], []
    for dsp_short_code, dsp_name in targets:
        key = normalize(dsp_name)
        candidates = prod_by_norm.get(key, [])
        if len(candidates) == 1:
            matched.append((dsp_short_code, dsp_name, candidates[0]))
        elif len(candidates) > 1:
            ambiguous.append((dsp_short_code, dsp_name, candidates))
        else:
            unmatched.append((dsp_short_code, dsp_name))

    print(f"\nMatched: {len(matched)}  Ambiguous: {len(ambiguous)}  Unmatched: {len(unmatched)}")

    update_sql = "update client_overview set fein=%s, updated_at=now() where dsp_short_code=%s"
    for dsp_short_code, dsp_name, prod_row in matched:
        fein = prod_row["fein_norm"] or None
        cur.execute(update_sql, (fein, dsp_short_code))
    conn.commit()

    if ambiguous:
        print("\nAmbiguous (multiple prod matches, skipped):")
        for code, name, cands in ambiguous:
            print(f"  {code} / {name!r} ->", [(c["company_name"], c["fein_norm"]) for c in cands])

    if unmatched:
        print(f"\nUnmatched ({len(unmatched)}) — no prod DSP org with a matching name:")
        for code, name in unmatched:
            print(f"  {code}: {name}")

    cur.execute("select count(*) from client_overview where fein is not null")
    print("\nclient_overview rows with fein set now:", cur.fetchone()[0])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
