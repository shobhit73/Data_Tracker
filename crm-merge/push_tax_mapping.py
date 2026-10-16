"""Load the clients' prior-payroll tax mapping files into the CRM's client_tax_mapping.

Input: a JSON list of mapping rows read off the Drive files (one object per row:
client, file_id, file_title, source_code, source_name, source_desc, uzio_code,
unique_tax_id, uzio_desc, uzio_sub_desc). Drive is read in Claude, not here.

State comes from the Unique Tax ID's FIPS prefix (17-000-0000-SIT-000 -> IL,
00-... -> Federal); the tax kind from its fourth segment (SIT, ER_SUTA -> SUTA).
The client is matched to its CRM short code by name, through the CRM's own
client list, the tracker profile and the API activity names.

    python push_tax_mapping.py <tax_mappings.json>            # dry run
    python push_tax_mapping.py <tax_mappings.json> --apply    # full replace

Credentials: the CRM env file (SUPABASE_URL + SUPABASE_SERVICE_KEY), same as
the other push scripts. Nothing is printed from it.
"""
import datetime, json, os, re, sys, urllib.request

CRM_ENV = (r"C:\Users\shobhit.sharma\.claude\projects\C--Users-shobhit-sharma-Downloads-Uzio-Code"
           r"\memory\_secrets\rohit-crm.env")
FIPS = {"01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
        "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
        "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
        "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
        "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
        "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
        "54": "WV", "55": "WI", "56": "WY", "72": "PR"}


def env():
    out = {}
    for line in open(CRM_ENV):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            out[k] = v.strip().strip('"')
    return out["SUPABASE_URL"], out.get("SUPABASE_SERVICE_KEY") or out["SERVICE_KEY"]


def call(url, key, method, path, body=None):
    req = urllib.request.Request(f"{url}/rest/v1/{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"apikey": key, "Authorization": "Bearer " + key,
                                          "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(req) as r:
        txt = r.read()
        return json.loads(txt) if txt else None


def norm(s):
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\b(llc|inc|incorporated|corp|corporation|co|ltd|dsp|the)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def state_and_kind(uid):
    parts = (uid or "").replace("\\", "").split("-")
    if len(parts) < 4:
        return None, None
    st = "Federal" if parts[0] == "00" else FIPS.get(parts[0])
    kind = parts[3].upper()
    return st, kind[3:] if kind.startswith("ER_") else kind


def main():
    rows = json.load(open(sys.argv[1], encoding="utf-8"))
    apply = "--apply" in sys.argv
    url, key = env()
    names = {}
    for c in call(url, key, "GET", "clients?select=dsp_name,short_code"):
        if c["short_code"]:
            names.setdefault(norm(c["dsp_name"]), c["short_code"])
    for p in call(url, key, "GET", "client_profile?select=dsp_name,dsp_short_code"):
        if p["dsp_short_code"]:
            names.setdefault(norm(p["dsp_name"]), p["dsp_short_code"])

    def code_for(client):
        n = norm(client)
        if n in names:
            return names[n]
        hits = {v for k, v in names.items() if k and (k.startswith(n) or n.startswith(k)) and min(len(k), len(n)) >= 5}
        return hits.pop() if len(hits) == 1 else None

    today = datetime.date.today().isoformat()
    send, unmatched, nostate = [], set(), 0
    for r in rows:
        st, kind = state_and_kind(r.get("unique_tax_id"))
        nostate += st is None
        code = code_for(r["client"])
        if not code:
            unmatched.add(r["client"])
        send.append({"dsp_short_code": code, "client_name": r["client"], "state": st, "tax_kind": kind,
                     "source_code": r.get("source_code") or None, "source_name": r.get("source_name") or None,
                     "source_desc": r.get("source_desc") or None, "uzio_code": r.get("uzio_code") or None,
                     "unique_tax_id": (r.get("unique_tax_id") or "").replace("\\", "") or None,
                     "uzio_desc": r.get("uzio_desc") or None, "uzio_sub_desc": r.get("uzio_sub_desc") or None,
                     "file_title": r.get("file_title"), "loaded_date": today,
                     "file_url": f"https://drive.google.com/file/d/{r['file_id']}/view" if r.get("file_id") else None})
    clients = {s["client_name"] for s in send}
    print(f"{len(send)} mapping rows for {len(clients)} clients | rows without a state: {nostate}")
    print("clients with no CRM short code (kept, shown by name):", sorted(unmatched) or "none")
    if "--out" in sys.argv:   # the exact rows that would be sent, for checking
        out = sys.argv[sys.argv.index("--out") + 1]
        json.dump(send, open(out, "w", encoding="utf-8"))
        print("wrote", out)
    if not apply:
        print("DRY RUN - nothing written. Re-run with --apply.")
        return
    if not send:
        sys.exit("nothing to write - refusing to empty client_tax_mapping")
    call(url, key, "DELETE", "client_tax_mapping?id=gt.0")
    for i in range(0, len(send), 500):
        call(url, key, "POST", "client_tax_mapping", send[i:i + 500])
    print(f"replaced client_tax_mapping in the CRM with {len(send)} rows")


if __name__ == "__main__":
    main()
