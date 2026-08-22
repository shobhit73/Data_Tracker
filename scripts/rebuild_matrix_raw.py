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

# The 11 exports that produced the committed matrix_raw.tsv, pinned by name.
# This was a glob ("Onbaording App Api runs*.csv"), which quietly broke the
# guard: Rohit's 18 Aug export follows the same naming, so it joined the
# "originals" and the verify then compared 12 exports against a file built from
# 11 and reported a logic mismatch that was really just new data. The check only
# means anything if the input set it replays is fixed.
ORIGINAL_FILES = [
    "Onbaording App Api runs till 150.csv",
    "Onbaording App Api runs from 150 and 270.csv",
    "Onbaording App Api runs from 271 and 370.csv",
    "Onbaording App Api runs from 371 and 530.csv",
    "Onbaording App Api runs from 531 and 630.csv",
    "Onbaording App Api runs from 631 and 730.csv",
    "Onbaording App Api runs from 731 and 790.csv",
    "Onbaording App Api runs from 791 and 900.csv",
    "Onbaording App Api runs from 901 and 1050.csv",
    "Onbaording App Api runs from 1051 and 1150.csv",
    "Onbaording App Api runs from 1151.csv",
    # The committed matrix_raw.tsv was rebuilt again once this 15 Aug export
    # landed, so the known-good baseline is these 12 files, not the first 11.
    # Verifying against 11 alone reported six lines "missing" that were simply
    # this export's data.
    "API Logs 15_08_02.csv",
    # Same again on 18 Aug: the baseline was rebuilt with Rohit's export but the
    # pin was not moved with it, so --verify replayed 12 files against a file
    # built from 13 and called it a logic mismatch. The seven "committed only"
    # lines were all dated 08-17/08-18 - this export's rows - and the three
    # "rebuild only" lines were the same keys falling back to older dates.
    # Whenever a rebuild --write is committed, the exports it consumed belong
    # here, or the guard reports new data as a broken rule.
    "Onbaording App Api runs from 1257.csv",
    # And a third time on 20 Aug: 'New Logs.csv' was written into the baseline
    # but not pinned, so --verify replayed 13 files against a file built from
    # 14. The signature is always the same - the "committed only" lines carry
    # the newer export's dates (here 08-18/08-19/08-20, plus fein 871375963,
    # which appears in no other export at all) and the "rebuild only" lines are
    # those same keys falling back to their previous, older dates.
    "New Logs.csv",
    # 22 Aug: pinned in the SAME change that wrote it into the baseline, which
    # is the only way this stops recurring. If you run --write and commit the
    # result, add the new export here before you finish - not next time.
    "New Logs 2208.csv",
]


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

    originals = sorted(os.path.join(DIR, n) for n in ORIGINAL_FILES)
    missing = [p for p in originals if not os.path.exists(p)]
    if missing:
        raise SystemExit("original export missing, cannot verify: %s"
                         % ", ".join(os.path.basename(p) for p in missing))
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
