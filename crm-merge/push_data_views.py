"""Push the dashboard's data-view tables into the CRM's Supabase (Phase 2).

Reads five tables from OUR Supabase (via scripts/supabase_helper) and replaces
their copies in the CRM's Supabase (service key from memory/_secrets/
rohit-crm.env). Each run is a full refresh: delete everything, insert the
current snapshot — these tables are read-only reporting data, there is nothing
in the CRM copies worth preserving.

Run scenarios:
  py crm-merge/push_data_views.py --dry-run   # row counts only, writes nothing
  py crm-merge/push_data_views.py             # the real push

Prerequisite: the tables exist in the CRM (2026-09-29-phase2-data-views.sql
run once in its SQL editor). Re-run this script whenever our source data is
refreshed (after load_api_activity.py, populate_payroll_health.py, etc.) —
until those loaders learn to write to the CRM directly, this is the bridge.
"""
import datetime
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
from supabase_helper import connect

CRM_ENV = (
    r"C:\Users\shobhit.sharma\.claude\projects\C--Users-shobhit-sharma-Downloads-Uzio-Code"
    r"\memory\_secrets\rohit-crm.env"
)

# source table -> columns NOT copied (the CRM table generates its own id).
TABLES = {
    "api_activity_runs": ["id"],
    "payroll_health": [],
    "client_data_coverage": [],
    "document_transfer": ["id"],
    "client_document_counts": [],
}
BATCH = 200


def crm_conf():
    conf = {}
    for line in open(CRM_ENV, encoding="utf-8-sig"):
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            conf[k.strip()] = v.strip()
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not conf.get(key):
            sys.exit("Missing %s in %s" % (key, CRM_ENV))
    return conf


def rest(conf, method, path, body=None):
    req = urllib.request.Request(
        conf["SUPABASE_URL"] + "/rest/v1/" + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
    )
    req.add_header("apikey", conf["SUPABASE_SERVICE_KEY"])
    req.add_header("Authorization", "Bearer " + conf["SUPABASE_SERVICE_KEY"])
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=minimal")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
    except urllib.error.HTTPError as e:
        sys.exit("%s %s failed: %s %s" % (method, path, e.code, e.read().decode()[:500]))


def fetch_source(cur, table, drop_cols):
    cur.execute('select * from "%s"' % table)
    cols = [d[0] for d in cur.description]
    keep = [i for i, c in enumerate(cols) if c not in drop_cols]
    rows = []
    for r in cur.fetchall():
        row = {}
        for i in keep:
            v = r[i]
            if isinstance(v, (datetime.date, datetime.datetime)):
                v = v.isoformat()
            row[cols[i]] = v
        rows.append(row)
    return rows


def main():
    dry = "--dry-run" in sys.argv
    cur = connect().cursor()
    conf = None if dry else crm_conf()

    for table, drop_cols in TABLES.items():
        rows = fetch_source(cur, table, drop_cols)
        if dry:
            print("PLAN  %-24s %4d rows" % (table, len(rows)))
            continue
        rest(conf, "DELETE", "%s?id=gt.0" % table)
        for i in range(0, len(rows), BATCH):
            rest(conf, "POST", table, rows[i:i + BATCH])
        print("PUSHED %-24s %4d rows" % (table, len(rows)))

    print("done (%s)" % ("dry run, nothing written" if dry else "CRM refreshed"))


if __name__ == "__main__":
    main()
