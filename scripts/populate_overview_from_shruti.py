"""Populate client_overview in Supabase from Shruti's 'DSP Implementation' tab.

Source CSV: data/shruti_dsp_implementation.csv (decoded by decode_dsp_sheet.py
from a Drive export of file 1GRnfKMp4tcjGXWhkx5rpRKQD8eadikZPNqeufctoXsI,
tab 'DSP Implementation'). Read-only against the sheet — this script never
writes back to Drive/Sheets, only to our own Supabase tables.

Column indices below are pinned to that tab's current header order (verified
via decode_dsp_sheet.py's header dump) — re-verify indices if the sheet's
columns are ever reordered.
"""
import csv
import datetime
import os
import re

from supabase_helper import connect

CSV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "shruti_dsp_implementation.csv",
)

COL = {
    "dsp_name": 0,
    "dsp_short_code": 1,
    "expected_tt_live_date": 3,
    "actual_tt_live_date": 4,
    "payroll_cutoff_date": 5,
    "payroll_live_date": 7,
    "rag_status": 8,
    "final_status": 9,
    "frequency": 14,
    "previous_system": 15,
    "implementor": 16,
    "state": 17,
    "data_transfer_paycom": 29,
    "data_transfer_adp": 30,
    "high_level_requirements": 20,
    "benefits_details": 66,
    "benefits_deductions_via": 67,
}

RAG_MAP = {"red": "Red", "amber": "Amber", "green": "Green"}

# The "High Level Requirement Details" cell is a small structured block:
#   Benefits: Decisely
#   401K: HI
#   Everify: Yes
#   ...
# Pull just the Benefits line. Horizontal whitespace only in the pattern —
# a plain \s* would swallow the newline and capture the 401K line instead.
BENEFITS_LINE = re.compile(r"benefits?[^\S\n]*[:\-][^\S\n]*([^\n]*)", re.I)


def parse_benefits_requirement(cell):
    """Return what the sheet records for Benefits, verbatim.

    Deliberately NOT reduced to yes/no: the recorded values are things like
    'Decisely', 'Innovative BPS', 'TBD', 'Not using our platform', 'Yes. they
    will use Uzio benefits module'. Which platform a client goes with IS the
    answer, so collapsing it to a boolean would throw away the useful part.
    """
    m = BENEFITS_LINE.search(cell or "")
    return (m.group(1).strip() or None) if m else None


def parse_date(s):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None  # non-date free text (e.g. notes typed into the wrong cell) — leave null


def parse_rag(s):
    return RAG_MAP.get((s or "").strip().lower())


def clean_name(s):
    """Some DSP Name cells have contact details typed in below the company name
    (newline-separated) — e.g. Goro Logistical carries a name/2 emails/a phone.
    Keep only the first line as the company name; the rest is recorded in
    source_row_notes so nothing from the sheet is silently dropped."""
    raw = (s or "").strip()
    first = raw.split("\n")[0].strip()
    extra = "\n".join(raw.split("\n")[1:]).strip()
    return first, extra


def infer_vendor(row):
    paycom = (row[COL["data_transfer_paycom"]] or "").strip()
    adp = (row[COL["data_transfer_adp"]] or "").strip()
    if paycom and adp:
        return None  # ambiguous — both columns populated
    if paycom:
        return "Paycom"
    if adp:
        return "ADP"
    return None


def main():
    with open(CSV_PATH, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        next(reader)  # header
        rows = list(reader)

    records = []
    skipped_blank = 0
    skipped_dupe = 0
    seen_codes = set()
    unparsed_dates = []
    no_vendor = []

    for row in rows:
        if len(row) <= max(COL.values()):
            row = row + [""] * (max(COL.values()) + 1 - len(row))
        dsp_name, name_extra = clean_name(row[COL["dsp_name"]])
        dsp_short_code = (row[COL["dsp_short_code"]] or "").strip()
        if not dsp_name or not dsp_short_code:
            skipped_blank += 1
            continue
        if dsp_short_code in seen_codes:
            skipped_dupe += 1
            continue
        seen_codes.add(dsp_short_code)

        vendor = infer_vendor(row)
        if vendor is None:
            no_vendor.append(dsp_short_code)

        notes = []
        if vendor is None:
            notes.append("vendor undetermined from Data Transfer (Paycom)/(ADP) columns")
        if name_extra:
            notes.append("extra text in DSP Name cell: " + name_extra.replace("\n", " | "))

        rec = {
            "dsp_short_code": dsp_short_code,
            "dsp_name": dsp_name,
            "vendor": vendor,
            "expected_tt_live_date": parse_date(row[COL["expected_tt_live_date"]]),
            "actual_tt_live_date": parse_date(row[COL["actual_tt_live_date"]]),
            "payroll_cutoff_date": parse_date(row[COL["payroll_cutoff_date"]]),
            "payroll_live_date": parse_date(row[COL["payroll_live_date"]]),
            "rag_status": parse_rag(row[COL["rag_status"]]),
            "final_status": (row[COL["final_status"]] or "").strip() or None,
            "frequency": (row[COL["frequency"]] or "").strip() or None,
            "previous_system": (row[COL["previous_system"]] or "").strip() or None,
            "implementor": (row[COL["implementor"]] or "").strip() or None,
            "state": (row[COL["state"]] or "").strip() or None,
            "benefits_requirement": parse_benefits_requirement(row[COL["high_level_requirements"]]),
            "benefits_details": (row[COL["benefits_details"]] or "").strip() or None,
            "benefits_deductions_via": (row[COL["benefits_deductions_via"]] or "").strip() or None,
            "source_row_notes": "; ".join(notes) or None,
        }
        for k in ("expected_tt_live_date", "payroll_cutoff_date"):
            raw = row[COL[k]]
            if raw.strip() and rec[k] is None:
                unparsed_dates.append((dsp_short_code, k, raw[:40]))
        records.append(rec)

    print(f"Parsed {len(records)} DSPs (skipped {skipped_blank} blank rows, {skipped_dupe} dupes)")
    if no_vendor:
        print(f"Vendor undetermined for {len(no_vendor)}: {no_vendor}")
    if unparsed_dates:
        print(f"Unparsed date values ({len(unparsed_dates)}):")
        for code, field, val in unparsed_dates[:15]:
            print(f"  {code} / {field}: {val!r}")

    conn = connect()
    cur = conn.cursor()
    cols = list(records[0].keys())
    placeholders = ", ".join(["%s"] * len(cols))
    collist = ", ".join(cols)
    # coalesce, not a blind overwrite: the sheet wins wherever it actually has a
    # value, but a blank cell must not wipe something filled in by hand in
    # Supabase. 62 DSPs have no vendor in the sheet, so a plain
    # `col = excluded.col` would blank out every manually-corrected vendor on
    # each scheduled run.
    updates = ", ".join(
        f"{c} = coalesce(excluded.{c}, client_overview.{c})"
        for c in cols if c != "dsp_short_code"
    )
    sql = (
        f"insert into client_overview ({collist}) values ({placeholders}) "
        f"on conflict (dsp_short_code) do update set {updates}, updated_at = now()"
    )
    for rec in records:
        cur.execute(sql, [rec[c] for c in cols])
    conn.commit()

    cur.execute("select count(*) from client_overview")
    print("client_overview row count now:", cur.fetchone()[0])
    cur.execute(
        "select rag_status, count(*) from client_overview group by rag_status order by 2 desc"
    )
    print("RAG breakdown:", cur.fetchall())
    cur.execute("select vendor, count(*) from client_overview group by vendor order by 2 desc")
    print("Vendor breakdown:", cur.fetchall())

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
