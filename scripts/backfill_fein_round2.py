"""Round 2 FEIN backfill for the DSPs backfill_fein.py couldn't match.

Round 1 only searched employer_organization where company_identifier like
'DSP%', which is a heuristic and can miss real Amazon-exchange employers that
don't (yet) have a DSP#### identifier. This round scopes correctly by
exchange_id (Amazon DSP exchange, per the employer-search-prod-query recipe)
and adds a substring-containment fuzzy pass for DBA suffixes / prefixes like
"ADG Holdings Companies > X" on top of round 1's exact-normalized match.

Auto-applies only high-confidence matches (exact-normalized or clean
substring containment). Anything looser is reported for manual confirmation,
never auto-assigned — a wrong FEIN links the wrong legal entity.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pq_helper
from supabase_helper import connect

AMAZON_EXCHANGE_ID = "EX-20243277-1b50-4035-821d-d0fcd9b895a9"
SUFFIXES = r"\b(LLC|L L C|INC|CORP|CORPORATION|CO|LTD|LP|DSP)\.?\b"


def normalize(name):
    n = (name or "").upper()
    n = re.sub(r"[.,]", " ", n)
    n = re.sub(SUFFIXES, " ", n)
    n = re.sub(r"[^A-Z0-9 ]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


def fetch_amazon_exchange_orgs():
    sql = (
        "select company_name, company_identifier, "
        "replace(coalesce(fein,''),'-','') as fein_norm, live_status "
        "from employer_organization "
        f"where deleted=0 and exchange_id='{AMAZON_EXCHANGE_ID}' "
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
    print("prod-query HTTP 200, rows:", len(body["data"]), "hasMore:", body.get("hasMore"))
    return body["data"]


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute("select dsp_short_code, dsp_name from client_overview where fein is null")
    targets = cur.fetchall()
    print(f"{len(targets)} DSPs still missing fein")

    prod_rows = fetch_amazon_exchange_orgs()
    for r in prod_rows:
        r["_norm"] = normalize(r["company_name"])

    auto_matched, needs_review, unmatched = [], [], []

    for dsp_short_code, dsp_name in targets:
        key = normalize(dsp_name)
        # pass 1: exact normalized
        exact = [r for r in prod_rows if r["_norm"] == key]
        if len(exact) == 1:
            auto_matched.append((dsp_short_code, dsp_name, exact[0], "exact"))
            continue
        if len(exact) > 1:
            needs_review.append((dsp_short_code, dsp_name, exact, "multiple exact matches"))
            continue

        # pass 2: whole-token containment (handles DBA suffixes / "ADG Holdings > X" prefixes).
        # Token-based, NOT raw substring — raw substring wrongly matched "EMF Logistics"
        # into "MF Logistics" because "MF" is a character-substring of "EMF".
        key_tokens = set(key.split())
        contains = []
        for r in prod_rows:
            rtokens = set(r["_norm"].split())
            if not key_tokens or not rtokens:
                continue
            shorter, longer = (key_tokens, rtokens) if len(key_tokens) <= len(rtokens) else (rtokens, key_tokens)
            if len(shorter) >= 2 and shorter <= longer:
                contains.append(r)
        if len(contains) == 1:
            auto_matched.append((dsp_short_code, dsp_name, contains[0], "substring"))
            continue
        if len(contains) > 1:
            needs_review.append((dsp_short_code, dsp_name, contains, "multiple substring matches"))
            continue

        # pass 3: token overlap — surfaced only, never auto-applied
        key_tokens = set(key.split())
        scored = []
        for r in prod_rows:
            rtokens = set(r["_norm"].split())
            if not key_tokens or not rtokens:
                continue
            overlap = key_tokens & rtokens
            if overlap:
                score = len(overlap) / len(key_tokens | rtokens)
                if score >= 0.3:
                    scored.append((score, r))
        if scored:
            scored.sort(key=lambda x: -x[0])
            needs_review.append((dsp_short_code, dsp_name, [r for _, r in scored[:3]], "fuzzy token overlap"))
        else:
            unmatched.append((dsp_short_code, dsp_name))

    print(f"\nAuto-matched (high confidence): {len(auto_matched)}")
    update_sql = "update client_overview set fein=%s, updated_at=now() where dsp_short_code=%s"
    for dsp_short_code, dsp_name, prod_row, how in auto_matched:
        fein = prod_row["fein_norm"] or None
        print(f"  [{how}] {dsp_short_code} {dsp_name!r} -> {prod_row['company_name']!r} fein={fein}")
        cur.execute(update_sql, (fein, dsp_short_code))
    conn.commit()

    if needs_review:
        print(f"\nNeeds manual review ({len(needs_review)}):")
        for dsp_short_code, dsp_name, cands, reason in needs_review:
            print(f"  {dsp_short_code} {dsp_name!r} [{reason}]:")
            for c in cands:
                print(f"      -> {c['company_name']!r} fein={c['fein_norm']} status={c['live_status']}")

    if unmatched:
        print(f"\nStill unmatched, no candidate at all ({len(unmatched)}):")
        for dsp_short_code, dsp_name in unmatched:
            print(f"  {dsp_short_code}: {dsp_name}")

    cur.execute("select count(*) from client_overview where fein is not null")
    print("\nclient_overview rows with fein set now:", cur.fetchone()[0])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
