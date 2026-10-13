"""Push crm-merge/data/signed_modules.json into the CRM's client_signed_modules.

Full replace, same shape as push_data_views.py: these are read-only reporting
rows extracted from Cuzio's customer pages (one-time backfill 13 Oct 2026; the
cuzio-crm-sync routine keeps NEW clients topped up afterwards).

  py crm-merge/push_signed_modules.py --dry-run
  py crm-merge/push_signed_modules.py
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data", "signed_modules.json")
CRM_ENV = (
    r"C:\Users\shobhit.sharma\.claude\projects\C--Users-shobhit-sharma-Downloads-Uzio-Code"
    r"\memory\_secrets\rohit-crm.env"
)


def conf_():
    conf = {}
    for line in open(CRM_ENV, encoding="utf-8-sig"):
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            conf[k.strip()] = v.strip()
    return conf


def rest(conf, method, path, body=None):
    req = urllib.request.Request(conf["SUPABASE_URL"] + "/rest/v1/" + path,
                                 method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("apikey", conf["SUPABASE_SERVICE_KEY"])
    req.add_header("Authorization", "Bearer " + conf["SUPABASE_SERVICE_KEY"])
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=minimal")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
    except urllib.error.HTTPError as e:
        sys.exit("%s %s failed: %s %s" % (method, path, e.code, e.read().decode()[:400]))


def main():
    dry = "--dry-run" in sys.argv
    src = json.load(open(DATA, encoding="utf-8"))
    rows = [{"dsp_short_code": r.get("dsp_short_code"),
             "dsp_name": r.get("dsp_name"),
             "modules": r.get("modules") or [],
             "notes": r.get("notes") or None,
             "source": r.get("source"),
             "contract_signed_date": r.get("contract_signed_date")} for r in src]
    withmods = sum(1 for r in rows if r["modules"])
    print("rows: %d (%d with a module list)" % (len(rows), withmods))
    if dry:
        print("dry run — nothing written")
        return
    conf = conf_()
    rest(conf, "DELETE", "client_signed_modules?id=gt.0")
    for i in range(0, len(rows), 200):
        rest(conf, "POST", "client_signed_modules", rows[i:i + 200])
    print("PUSHED client_signed_modules = %d rows" % len(rows))


if __name__ == "__main__":
    main()
