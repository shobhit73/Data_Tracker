"""Regenerate data/matrix_raw.tsv from the PHIX-72859 CSV exports.

Until now this file was built inline during a session (see the project CLAUDE.md
note) - so adding a new export meant redoing that by hand. This makes it a real
script, because a new log lands on the ticket every so often.

The rule, unchanged from the original inline build: a run "touched" a module if
that module appears as a TOP-LEVEL KEY in either the error_messages or the
optional_validations JSON. Both are present whether or not the run failed, so
this reads as "which module did this run exercise", not "which module broke".
Per (fein, section) only the latest created_date survives, with its created_by.

Safety: run with --verify first. That rebuilds from the ORIGINAL 11 exports
only and diffs against the committed matrix_raw.tsv. If the logic here does not
reproduce that file byte for byte, the reimplementation is wrong and the run
stops rather than silently rewriting history with a different rule.

  python rebuild_matrix_raw.py --verify   # prove the logic, touch nothing
  python rebuild_matrix_raw.py --write    # rebuild including every CSV present

This script does NOT touch the database. Loading into api_activity_runs is a
separate step (load_api_activity.py), so a bad parse cannot reach Supabase.
"""
import csv
import glob
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
csv.field_size_limit(10_000_000)

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(PROJECT, "data")
DIR = r"C:\Users\shobhit.sharma\Downloads\PHIX-72859-onboarding-apis"
TSV = os.path.join(BASE, "matrix_raw.tsv")

# The 11 exports that produced the committed matrix_raw.tsv.
ORIGINAL_GLOB = "Onbaording App Api runs*.csv"


def sections(row):
    """Top-level keys of the two JSON blobs = the modules this run touched."""
    found = set()
    for col in ("error_messages", "optional_validations"):
        raw = (row.get(col) or "").strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            found.update(obj.keys())
    return found


def build(paths):
    """(fein, section) -> (last_date, by), keeping the latest created_date."""
    latest = {}
    rows_read = 0
    for path in paths:
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                rows_read += 1
                fein = (row.get("fein") or "").strip()
                created = (row.get("created_date") or "").strip()
                by = (row.get("created_by") or "").strip()
                if not fein or not created:
                    continue
                day = created.split(" ")[0]
                who = by.split("@")[0]
                for sec in sections(row):
                    key = (fein, sec)
                    if key not in latest or created > latest[key][0]:
                        latest[key] = (created, day, who)
    return latest, rows_read


def as_lines(latest):
    out = ["fein\tsection\tlast\tby"]
    for (fein, sec), (_created, day, who) in sorted(latest.items()):
        out.append(f"{fein}\t{sec}\t{day}\t{who}")
    return out


def read_committed():
    with open(TSV, encoding="utf-8") as fh:
        return [l.rstrip("\n") for l in fh if l.strip()]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--verify"

    originals = sorted(glob.glob(os.path.join(DIR, ORIGINAL_GLOB)))
    every = sorted(glob.glob(os.path.join(DIR, "*.csv")))
    extra = [p for p in every if p not in originals]

    print(f"original exports: {len(originals)}")
    print(f"additional CSVs : {len(extra)}")
    for p in extra:
        print(f"  + {os.path.basename(p)}")

    latest_orig, n_orig = build(originals)
    rebuilt = as_lines(latest_orig)
    committed = read_committed()

    print(f"\nrebuilt from originals: {len(rebuilt) - 1} rows ({n_orig:,} CSV rows read)")
    print(f"committed matrix_raw  : {len(committed) - 1} rows")

    if rebuilt == committed:
        print("VERIFY OK - logic reproduces the committed file exactly.")
    else:
        only_new = set(rebuilt) - set(committed)
        only_old = set(committed) - set(rebuilt)
        print(f"MISMATCH - {len(only_new)} lines only in rebuild, "
              f"{len(only_old)} only in committed")
        for line in sorted(only_new)[:10]:
            print("  rebuild only :", line)
        for line in sorted(only_old)[:10]:
            print("  committed only:", line)
        raise SystemExit("Logic does not match the original build - not writing.")

    if mode != "--write":
        print("\n(--verify only; nothing written. Re-run with --write to include "
              "the additional CSVs.)")
        return

    latest_all, n_all = build(every)
    full = as_lines(latest_all)

    added = set(full) - set(committed)
    removed = set(committed) - set(full)
    print(f"\nrebuilt from ALL CSVs: {len(full) - 1} rows ({n_all:,} CSV rows read)")
    print(f"  new/changed lines: {len(added)}")
    for line in sorted(added):
        print("   +", line)
    if removed:
        print(f"  lines no longer produced: {len(removed)}")
        for line in sorted(removed):
            print("   -", line)

    with open(TSV, "w", encoding="utf-8", newline="") as fh:
        fh.write("\n".join(full) + "\n")
    print(f"\nwritten: {TSV}")


if __name__ == "__main__":
    main()
