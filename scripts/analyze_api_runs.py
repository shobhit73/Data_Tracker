import csv, json, glob, re, os
from collections import defaultdict

DIR = r"C:\Users\shobhit.sharma\Downloads\PHIX-72859-onboarding-apis"
FEIN_TO_CLIENT = {
    '920720113': 'Spelman Logistics Inc',
    '993347180': 'Lazo Logistics LLC',
    '333760897': 'North Star Parcel LLC',
    '920241570': 'Flash Hub Delivery',
}
TARGET_FEINS = set(FEIN_TO_CLIENT.keys())

csv.field_size_limit(10_000_000)

rows = []
for path in glob.glob(os.path.join(DIR, "*.csv")):
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            if r.get('fein') in TARGET_FEINS:
                rows.append(r)

print(f"Total matching rows across {len(TARGET_FEINS)} FEINs: {len(rows)}")

# error category normalizer -> human label
CATEGORY_RULES = [
    (r"already exist for employeeId", "Duplicate employee (already exists in Uzio)"),
    (r"Mandatory field .* is missing or empty", "Missing mandatory field"),
    (r"Mandatory field .* for .* is missing or empty", "Missing mandatory field (nested)"),
    (r"Job Title '.*' has an empty mapping value", "Job title has no mapping configured"),
    (r"No employeeCode exists for employeeId|Employee code not found in the system", "Employee not yet onboarded in Uzio"),
    (r"Work Location '.*' is not a valid work location", "Work location not recognized"),
    (r"Worker.s Comp Code is mandatory", "Worker's comp code missing"),
    (r"SOC code is missing", "SOC code missing"),
    (r"SOC code is invalid", "SOC code invalid format"),
    (r"was not found in the system", "Referenced worker not found in Uzio"),
    (r"excpetionId|Something went wrong", "Generic API/system error (no detail given)"),
    (r"Tax mapping not found", "Tax code has no mapping configured"),
    (r"Invalid State filing status", "Invalid state filing status"),
    (r"overlapping with past or future entry", "Overlapping deduction period"),
    (r"API returned status: 400", "Downstream API rejected the record (400)"),
    (r"Dependents.*mandatory", "Dependents count missing (FIT)"),
    (r"invalid date format", "Invalid date format"),
    (r"FLSA Classification .* is not a valid value", "Invalid FLSA classification"),
    (r"Contribution description .* is not found in the contribution mapping", "Contribution type has no mapping configured"),
    (r"Zip code validation service error", "Zip code validation service failure (downstream)"),
    (r"is not a valid state", "Invalid state code"),
    (r"could not determine state", "Could not determine state from address"),
    (r"Duplicate SSN", "Duplicate SSN"),
    (r"Invalid Email Address|Invalid email", "Invalid email address"),
    (r"already terminated|Termination Date should be after", "Termination date issue"),
]

def categorize(detail):
    for pattern, label in CATEGORY_RULES:
        if re.search(pattern, detail, re.IGNORECASE):
            return label
    return "Other / uncategorized"

# per client -> per section -> stats
data = defaultdict(lambda: defaultdict(lambda: {
    "runs": 0, "first": None, "last": None, "error_count": 0,
    "total_attempted": 0, "success": 0, "failure": 0,
    "categories": defaultdict(int), "runners": set()
}))

def parse_totals(resp_body_str, sec):
    """Read Total/SuccessMap/FailureMap out of response_body for this section, if present."""
    if not resp_body_str or not resp_body_str.strip():
        return None
    try:
        obj = json.loads(resp_body_str)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    tmap = obj.get("TotalMap") or {}
    smap = obj.get("SuccessMap") or {}
    fmap = obj.get("FailureMap") or {}
    if sec in tmap or sec in smap or sec in fmap:
        return {
            "total": int(tmap.get(sec, 0) or 0),
            "success": int(smap.get(sec, 0) or 0),
            "failure": int(fmap.get(sec, 0) or 0),
        }
    return None

for r in rows:
    fein = r['fein']
    client = FEIN_TO_CLIENT[fein]
    created_date = (r.get('created_date') or '')[:10]
    created_by = r.get('created_by') or ''
    err_raw = r.get('error_messages') or ''
    resp_raw = r.get('response_body') or ''

    sections_seen = set()
    err_obj = {}
    if err_raw.strip():
        try:
            err_obj = json.loads(err_raw)
        except Exception:
            err_obj = {}
    for sec in err_obj.keys():
        sections_seen.add(sec)

    opt_raw = r.get('optional_validations') or ''
    if opt_raw.strip():
        try:
            opt_obj = json.loads(opt_raw)
            for sec in opt_obj.keys():
                sections_seen.add(sec)
        except Exception:
            pass

    if not sections_seen:
        continue

    for sec in sections_seen:
        d = data[client][sec]
        d["runs"] += 1
        if created_date:
            if d["first"] is None or created_date < d["first"]:
                d["first"] = created_date
            if d["last"] is None or created_date > d["last"]:
                d["last"] = created_date
        if created_by:
            d["runners"].add(created_by.split('@')[0])
        errs = err_obj.get(sec, [])
        d["error_count"] += len(errs)
        for e in errs:
            detail = e.get("errorDetails", "")
            d["categories"][categorize(detail)] += 1

        totals = parse_totals(resp_raw, sec)
        if totals:
            d["total_attempted"] += totals["total"]
            d["success"] += totals["success"]
            d["failure"] += totals["failure"]

# print structured summary
for client in FEIN_TO_CLIENT.values():
    print("\n=====", client, "=====")
    secs = data.get(client, {})
    for sec, d in sorted(secs.items(), key=lambda kv: -kv[1]["runs"]):
        print(f"-- {sec}: runs={d['runs']} first={d['first']} last={d['last']} "
              f"total_attempted={d['total_attempted']} success={d['success']} failure={d['failure']} "
              f"runners={sorted(d['runners'])}")
        all_cats = sorted(d["categories"].items(), key=lambda kv: -kv[1])
        for cat, cnt in all_cats:
            print(f"     {cnt:4d}x {cat}")

    tot_att = sum(d["total_attempted"] for d in secs.values())
    tot_succ = sum(d["success"] for d in secs.values())
    tot_fail = sum(d["failure"] for d in secs.values())
    firsts = [d["first"] for d in secs.values() if d["first"]]
    lasts = [d["last"] for d in secs.values() if d["last"]]
    rate = (tot_succ / tot_att * 100) if tot_att else 0
    print(f"   ROLLUP: sections={len(secs)} total_attempted={tot_att} success={tot_succ} "
          f"failure={tot_fail} success_rate={rate:.1f}% span={min(firsts) if firsts else '-'}"
          f" -> {max(lasts) if lasts else '-'}")
