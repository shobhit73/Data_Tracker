"""Read-only: compare the newly uploaded PHIX-72859 API log against the format
the existing loader expects. Writes nothing.
"""
import csv
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
csv.field_size_limit(10_000_000)

DIR = r"C:\Users\shobhit.sharma\Downloads\PHIX-72859-onboarding-apis"
NEW = "API Logs 15_08_02.csv"
OLD = "Onbaording App Api runs from 1151.csv"


def head(path, n=2):
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        rdr = csv.reader(fh)
        cols = next(rdr)
        rows = [r for _, r in zip(range(n), rdr)]
    return cols, rows


def main():
    for label, name in (("OLD", OLD), ("NEW", NEW)):
        path = os.path.join(DIR, name)
        cols, rows = head(path)
        print("=" * 78)
        print(f"{label}: {name}")
        print(f"  {len(cols)} columns: {cols}")
        for r in rows:
            print("  --- sample row ---")
            for c, v in zip(cols, r):
                v = (v or "")[:160].replace("\n", " ")
                print(f"    {c}: {v}")
            break

    # row count of the new file
    path = os.path.join(DIR, NEW)
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        n = sum(1 for _ in csv.reader(fh)) - 1
    print("=" * 78)
    print(f"NEW file data rows: {n}")


if __name__ == "__main__":
    main()
