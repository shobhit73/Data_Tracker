"""Per-client ADP/Paycom access status, from the team's access spreadsheet.

WHY THIS EXISTS
    Historical tracking assumes the old platform can still be reached. It
    cannot always: credentials go missing, get revoked, or stop working, and
    once that happens a report sitting at 'Pending' is not work waiting to be
    done, it is data that can never be collected. This records which side of
    that line each client is on.

    It pairs with historical_scope_excluded: this table is the *observation*
    (what the team found when they tried to log in), the exclusion table is the
    *decision* (stop tracking this client). They can disagree, and when they do
    the disagreement is the interesting part — a client marked "Has access"
    here but excluded there means someone learned something newer than the
    spreadsheet.

CREDENTIALS ARE NEVER STORED
    The source column mixes status text with live ADP/Paycom usernames and
    passwords in plain text. This dashboard is public and its anon key is
    readable in the page source, so the raw cell must not reach the database.
    Each cell is classified into one of the STATUSES below and the text is then
    discarded; `notes` only ever holds a fixed phrase chosen from that list,
    never anything copied out of the sheet.

FDQOT
    The sheet's second column tracks whether the downloaded file contains the
    qualified-overtime figure (FDQOT = federal deductible qualified overtime),
    which is the same OBBB requirement the Qualified Overtime report covers in
    historical_report_catalog. Kept here because "we have the file but it has
    no FDQOT column" is a distinct problem from "we never got the file".

Run:  python load_platform_access.py "<path to xlsx>"
Writes only client_platform_access.
"""
import os
import re
import sys
from difflib import SequenceMatcher

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DDL = """
create table if not exists client_platform_access (
    dsp_short_code text primary key references client_overview(dsp_short_code) on delete cascade,
    access_status  text not null,
    fdqot_in_file  text,
    lk1_prior_year text,
    source_name    text,
    checked_on     date not null default current_date,
    updated_at     timestamptz not null default now()
);
grant select on client_platform_access to anon, authenticated;
"""

# Order matters: the first pattern that matches wins, so the specific ("access
# lost" even when a login was also written down) is tested before the generic
# "a login was recorded here, so we were evidently able to get in".
#
# Note what the last rule does NOT do: it does not look for the passwords
# themselves. Matching on their actual text would mean writing fragments of
# live ADP/Paycom passwords into this file, which is in a public repo — the
# leak this script exists to prevent. A credential cell is instead recognised
# by its shape (a recorded client/company code, or a multi-line blob that no
# status phrase explains), which needs no knowledge of the secret.
RULES = [
    ("Exited from Amazon",     lambda s: "exited from amazon" in s),
    ("Not started",            lambda s: "future implementation" in s),
    ("Access lost",            lambda s: "access lost" in s),
    ("Credentials not working", lambda s: "aren't working" in s or "not working" in s),
    ("Blocked on OTP",         lambda s: "otp" in s),
    ("No credentials",         lambda s: "credential" in s and
                                         ("not found" in s or "didn't find" in s or "we don" in s)),
    ("Has access",             lambda s: "report downloaded" in s
                                         or re.search(r"\b(client|company)\s+code\b", s) is not None
                                         or len([l for l in s.splitlines() if l.strip()]) > 1),
]


def classify(cell):
    s = (cell or "").strip().lower()
    if not s:
        return "Unknown"
    for label, test in RULES:
        if test(s):
            return label
    return "Unknown"


def norm(s):
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    s = re.sub(r"\b(llc|inc|corp|corporation|ltd|co|logistics|delivery|the)\b", " ", s)
    return " ".join(s.split())


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: python load_platform_access.py "<path to xlsx>"')
    path = sys.argv[1]

    ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    raw = [[("" if v is None else str(v).strip()) for v in r]
           for r in ws.iter_rows(min_row=2, values_only=True)]
    raw = [r for r in raw if r and r[0]]

    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(DDL)

    cur.execute("select dsp_short_code, dsp_name from client_overview")
    known = cur.fetchall()

    rows, unmatched = [], []
    for r in raw:
        name = r[0]
        n = norm(name)
        best, score = None, 0.0
        for code, dbname in known:
            sc = SequenceMatcher(None, n, norm(dbname)).ratio()
            if sc > score:
                best, score = code, sc
        # 0.82 keeps "Northstar Logistics NYC" -> NRCS while rejecting the
        # sheet's "ADP" section header, whose closest match scores 0.50.
        if score < 0.82:
            unmatched.append((name, best, round(score, 2)))
            continue
        rows.append((best, classify(r[1]),
                     r[2] if len(r) > 2 and r[2] else None,
                     r[3] if len(r) > 3 and r[3] else None,
                     os.path.basename(path)))

    cur.executemany(
        "insert into client_platform_access "
        "(dsp_short_code, access_status, fdqot_in_file, lk1_prior_year, source_name, checked_on) "
        "values (%s,%s,%s,%s,%s,current_date) "
        "on conflict (dsp_short_code) do update set "
        "access_status=excluded.access_status, fdqot_in_file=excluded.fdqot_in_file, "
        "lk1_prior_year=excluded.lk1_prior_year, source_name=excluded.source_name, "
        "checked_on=current_date, updated_at=now()",
        rows)
    print(f"{len(rows)} clients written, {len(unmatched)} rows unmatched")
    for name, closest, sc in unmatched:
        print(f"  unmatched: {name!r} (closest {closest} at {sc})")

    cur.execute("select access_status, count(*) from client_platform_access "
                "group by 1 order by 2 desc")
    print("\naccess status:")
    for status, n in cur.fetchall():
        print(f"  {n:>2}  {status}")

    # The point of the table: clients still being tracked whose access is gone.
    cur.execute("""
        select s.dsp_short_code, a.access_status
        from historical_scope s
        join client_platform_access a on a.dsp_short_code = s.dsp_short_code
        where a.access_status in ('Access lost','No credentials','Credentials not working',
                                  'Blocked on OTP','Exited from Amazon')
        order by 1""")
    bad = cur.fetchall()
    if bad:
        print("\nstill in the historical window, but access is not usable:")
        for code, status in bad:
            print(f"  {code:6} {status}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
