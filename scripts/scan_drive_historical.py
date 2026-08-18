"""Walk each in-scope client's Drive folder and mark historical reports Received.

This script does NOT talk to Drive itself — the Drive connector lives in Claude,
not in Python. It takes a JSON listing of the files found under a client's
folder and does the matching, so the same matching rules are used every time
instead of being re-improvised per session.

Usage
-----
1. In Claude, list the client's TOP-LEVEL folder recursively with the Drive
   connector and save the result as JSON:

   IMPORTANT — start at the client folder ("Lazo Logistics LLC"), NOT at its
   "Historical Data" subfolder. historical_scope.folder_url points at the
   Historical Data subfolder, and listing only that is how the Qualified
   Overtime report went unnoticed for two months: those files are filed at the
   client root, or in sibling folders named "Payroll Data" / "Payroll Reports" /
   "<Client> Payroll Data". Anything filed outside Historical Data is invisible
   to a scan that starts there, and shows as Pending when it has actually
   arrived.

       [{"dsp_short_code": "LAZO",
         "folder_id": "1f1BdK9GU_svWLybvnigxJFz-lUS8WyaF",
         "folders": {"": "1f1BdK9GU_svWLybvnigxJFz-lUS8WyaF",
                     "Audit Trial": "1mSFFi5Yds7Q7uH1MDNkDRvNDHOtfvxHf"},
         "files": ["HistoricalPayroll_2023.xlsx",
                   "Timecard_Report_with_Notes_2025-to-date.xlsx",
                   "Audit Trial/Lazo_..._Q1-2025.xlsx", ...]}]

   `folders` maps a path prefix ("" for the root) to that folder's Drive id, so
   every matched report can carry a link back to where the file actually sits.
   It is optional — without it the scan still works, just without links.

2. python scan_drive_historical.py <that-file.json> [--apply]

Without --apply it only prints what it would change. Nothing is written until
you have looked at the matches, because a wrong tick here reads as "we have
that data" when we do not.

Matching
--------
A file matches a report when the report's keywords all appear in the filename
(case- and separator-insensitive). For year/quarter reports the unit label must
also appear: '2024' for a Payroll History year, '2025 Q1' / '2025-Q1' / 'Q1
2025' for an Audit Trail quarter.

Anything unmatched is listed at the end. That list is the useful output — it is
either a report nobody has downloaded yet, or a file named in a way the rules
do not recognise, and both are worth seeing.
"""
import json
import re
import sys

from supabase_helper import connect

# Report name -> the keywords that must all be present in a filename.
# Keys are (vendor, report_name) exactly as they appear in the catalogue.
KEYWORDS = {
    # --- ADP ---
    # Saved either as HistoricalPayroll_2025.xlsx or as
    # "Payroll History_Q1_2026_per_pay_period.xlsx" depending on who pulled it.
    ("ADP", "Payroll History"): [["historicalpayroll"], ["payroll", "history"]],
    ("ADP", "Time Off Balance Detail"): ["timeoff", "balance", "detail"],
    ("ADP", "Time Off Balance Summary"): ["timeoff", "balance", "summary"],
    ("ADP", "Time Off Policy Assignment"): ["timeoff", "policy"],
    ("ADP", "Time Off Request"): ["timeoff", "request"],
    ("ADP", "Timecard Report with Supervisor Approval"): ["timecard", "supervisor"],
    ("ADP", "Timecard Report with Notes"): ["timecard", "notes"],
    ("ADP", "Timecard Exception Report"): ["timecard", "exception"],
    # Just "audit": the folder is spelt "Audit Trial" but the files inside are
    # "Audit_Trail_Report", so neither "trail" nor "tri" matches both. The
    # quarter check below is what actually pins this report down, and the loose
    # I-9 exports sitting in the same folder have no quarter so they cannot
    # match it by accident.
    ("ADP", "Audit Trail"): ["audit"],
    ("ADP", "Form I-9 and E-Verify Information"): ["i9", "everify"],
    # ADP calls the garnishment report an Employee Lien Report. Files get saved
    # under either word depending on who pulled them, so accept both — the
    # nested list means "any of these alternatives", not "all of these words".
    ("ADP", "Employee Lien Report"): [["lien"], ["garnishment"]],
    # The docstring above warns that these files hide outside Historical Data,
    # but the matching rule itself was never added — so even a scan started at
    # the client root dropped them into "unmatched" and the row stayed Pending.
    # Just "overtime": no other ADP report mentions it, and filenames vary
    # ("Qualified Overtime Wages And Tips.xlsx",
    #  "InnovDel_Qualified Overtime Wages And Tips.xlsx").
    ("ADP", "Qualified Overtime Wages And Tips"): ["overtime"],
    # --- Paycom ---
    ("Paycom", "Employee Time-Off"): ["employee", "timeoff"],
    ("Paycom", "Holiday/Blackout"): ["holiday"],
    ("Paycom", "Time-Off Audit"): ["timeoff", "audit"],
    ("Paycom", "Time-Off Summary"): ["timeoff", "summary"],
    ("Paycom", "Salary Time Off Absence Tracking"): ["absence"],
    ("Paycom", "Break/Lunch Duration"): ["break", "duration"],
    ("Paycom", "Employee Punch Change"): ["punch", "change"],
    ("Paycom", "Employee Rates by Allocation"): ["rates", "allocation"],
    ("Paycom", "Hours Worked vs Threshold"): ["threshold"],
    ("Paycom", "Labor Allocation"): ["labor", "allocation"],
    ("Paycom", "Labor Analysis/Overtime"): ["labor", "analysis"],
    ("Paycom", "Missed Break/Lunch"): ["missed", "break"],
    ("Paycom", "Missing Punch"): ["missing", "punch"],
    ("Paycom", "Pay Class Effective Date"): ["payclass"],
    ("Paycom", "Punch Audit"): ["punch", "audit"],
    ("Paycom", "Punches Outside Current Allocation"): ["punches", "outside"],
    ("Paycom", "Time Between Shifts"): ["between", "shifts"],
    ("Paycom", "Time Detail"): ["time", "detail"],
    ("Paycom", "Timecard Approval"): ["timecard", "approval"],
    ("Paycom", "Total Hours by Time Range"): ["totalhours", "range"],
    ("Paycom", "Total Hours Summary by Allocation"): ["totalhours", "summary", "allocation"],
    ("Paycom", "Total Hours Summary"): ["totalhours", "summary"],
    ("Paycom", "Zero Hours Summary"): ["zerohours"],
    ("Paycom", "Accrual Balances"): ["accrual", "balance"],
    ("Paycom", "Accrual Detail"): ["accrual", "detail"],
    ("Paycom", "Accrual Summary"): ["accrual", "summary"],
    ("Paycom", "Historical Accrual Data"): ["historical", "accrual"],
    ("Paycom", "Effective Dates"): ["effective", "date"],
    ("Paycom", "Employee Changes"): ["employee", "change"],
    ("Paycom", "Employee Dates"): ["employee", "date"],
    ("Paycom", "Rate History"): ["rate", "history"],
    ("Paycom", "Employee Accrual"): ["employee", "accrual"],
    ("Paycom", "Equifax TWN Feed"): ["equifax"],
    ("Paycom", "Employee 3rd Party Payee"): ["3rdparty"],
    ("Paycom", "Employee Rates"): ["employee", "rates"],
    ("Paycom", "Employee Position"): ["employee", "position"],
    ("Paycom", "Position Discrepancy"): ["position", "discrepancy"],
    ("Paycom", "Position Management Audit"): ["position", "management"],
    ("Paycom", "Point-in-Time"): ["pointintime"],
    ("Paycom", "Changed Contact"): ["changed", "contact"],
    ("Paycom", "Form I-9 Audit Report"): ["i9", "audit"],
    ("Paycom", "Prior Payroll (Advanced Report Writer, consolidated)"): ["priorpayroll"],
    ("Paycom", "E-Verify Cases (grid export)"): ["everify", "cases"],
    ("Paycom", "E-Verify Case Details (all cases)"): ["everify", "case", "details"],
    ("Paycom", "Garnishment Report"): ["garnishment"],
}


def norm(s):
    """Lowercase and strip every separator, so 'Time_Off Balance-Detail.xlsx'
    and 'timeoffbalancedetail' compare equal."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def alternatives(spec):
    """KEYWORDS values are normally a flat list of words that must ALL appear.
    A nested list means alternatives — any one of them matching is enough.
    Normalising here keeps the matching loop simple."""
    return spec if spec and isinstance(spec[0], list) else [spec]


def match_score(spec, report_name, filename):
    """0 if the file does not match, otherwise how specific the match is.

    Specificity matters because several report names are contained in others:
    'Employee Rates' inside 'EmployeeRatesByAllocation', 'Employee Changes'
    inside 'EmployeePunchChange', 'Effective Dates' inside
    'PayClassEffectiveDate'. Each file therefore goes to its highest-scoring
    report rather than to whichever came first in the catalogue.

    The report's own name appearing whole in the filename outranks any keyword
    match. Scoring on keyword length alone is not enough: 'employee'+'change'
    is more characters than 'punch'+'change', so Employee Changes would still
    have stolen EmployeePunchChange's file."""
    n = norm(filename)
    whole = norm(report_name)
    if whole and whole in n:
        return 1000 + len(whole)
    best = 0
    for alt in alternatives(spec):
        if all(k in n for k in alt):
            best = max(best, sum(len(k) for k in alt))
    return best


def unit_in_filename(unit_label, filename):
    """Is this specific year/quarter present in the filename?"""
    if unit_label == "Report":
        return True
    n = norm(filename)
    if re.fullmatch(r"\d{4}", unit_label):
        return unit_label in n
    m = re.match(r"(\d{4}) Q([1-4])", unit_label)
    if m:
        year, q = m.group(1), m.group(2)
        # accept 2025Q1, Q12025, and 2025_1
        return (year + "q" + q) in n or ("q" + q + year) in n
    return False


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    apply = "--apply" in sys.argv
    with open(sys.argv[1], encoding="utf-8") as f:
        payload = json.load(f)

    conn = connect()
    cur = conn.cursor()
    cur.execute(
        """select s.dsp_short_code, s.vendor, c.id, c.report_name, r.unit_label, r.status
           from historical_scope s
           join historical_report_catalog c on c.vendor = s.vendor
           join historical_report_status r
             on r.dsp_short_code = s.dsp_short_code and r.report_id = c.id"""
    )
    expected = cur.fetchall()

    FOLDER_URL = "https://drive.google.com/drive/folders/"

    def folder_url_for(entry, filename):
        """The Drive folder a matched file lives in. Files are listed as
        'Subfolder/name.xlsx', so the prefix before the last '/' is the key."""
        folders = entry.get("folders") or {}
        prefix = filename.rsplit("/", 1)[0] if "/" in filename else ""
        fid = folders.get(prefix) or folders.get("") or entry.get("folder_id")
        return FOLDER_URL + fid if fid else None

    updates, unmatched_all = [], {}
    for entry in payload:
        code = entry["dsp_short_code"]
        files = entry.get("files", [])
        mine = [e for e in expected if e[0] == code]
        if not mine:
            print(f"!! {code} is not in historical_scope — skipped")
            continue
        vendor = mine[0][1]
        status_of = {(rid, unit): status for _, _, rid, _, unit, status in mine}

        # Walk files, not reports: give each file to the single report that
        # matches it most specifically. One file per report-unit — a second
        # year's copy of the same report does not need its own slot.
        claimed, recognised = {}, set()
        for fn in files:
            best, best_score = None, 0
            for _, _, rid, rname, unit, _ in mine:
                kws = KEYWORDS.get((vendor, rname))
                if not kws or not unit_in_filename(unit, fn):
                    continue
                score = match_score(kws, rname, fn)
                if score > best_score:
                    best_score, best = score, (rid, rname, unit)
            if not best:
                continue
            recognised.add(fn)
            key = (best[0], best[2])
            if key not in claimed:
                claimed[key] = (best[1], fn)

        # Always re-write links, even for rows already Received — an earlier
        # scan may have marked them before links were being captured.
        for (rid, unit), (rname, fn) in claimed.items():
            updates.append((code, rid, unit, rname, fn, folder_url_for(entry, fn),
                            status_of.get((rid, unit)) == "Received"))

        leftover = [f for f in files if f not in recognised]
        if leftover:
            unmatched_all[code] = leftover

    fresh = [u for u in updates if not u[6]]
    print(f"\n{len(fresh)} newly marked Received "
          f"({len(updates) - len(fresh)} already Received, links refreshed):")
    for code, rid, unit, rname, fn, url, already in updates:
        label = rname + (f" [{unit}]" if unit != "Report" else "")
        print(f"  {'   ' if already else 'NEW'} {code:6s} {label:50s} <- {fn}")

    if unmatched_all:
        print("\nFiles in Drive that matched no report (check these — either an "
              "extra download or a naming the rules miss):")
        for code, files in unmatched_all.items():
            for f in files:
                print(f"  {code:6s} {f}")

    if not apply:
        print("\nDry run. Re-run with --apply to write these to Supabase.")
        return

    for code, rid, unit, _, fn, url, _already in updates:
        cur.execute(
            """update historical_report_status
               set status='Received', checked_date=current_date,
                   file_name=%s, folder_url=%s, updated_at=now()
               where dsp_short_code=%s and report_id=%s and unit_label=%s""",
            (fn.rsplit("/", 1)[-1], url, code, rid, unit),
        )

    # The client's own historical folder, for the link on the card header.
    for entry in payload:
        root = (entry.get("folders") or {}).get("") or entry.get("folder_id")
        if root:
            cur.execute(
                "update historical_scope set folder_url=%s where dsp_short_code=%s",
                (FOLDER_URL + root, entry["dsp_short_code"]),
            )
    conn.commit()
    print(f"\napplied: {len(fresh)} newly Received, {len(updates)} rows carry a link")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
