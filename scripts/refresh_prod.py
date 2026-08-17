"""Deterministic half of the twice-daily refresh: everything that comes from
prod and needs no judgement. Safe to run unattended and safe to run repeatedly.

What it does:
  1. backfill_fein          - match unmatched DSPs to prod employers by name
  2. populate_work_locations - refresh every matched DSP's work locations
  3. populate_data_coverage  - count how many employees actually have a payment
                               method / emergency contact yet

What it deliberately does NOT touch:
  - open_items and historical_data_checklist  -> human-owned, no script writes
  - client_overview                           -> comes from Shruti's sheet
  - audit_coverage / document_transfer        -> come from email, need reading

Run:  python refresh_prod.py
"""
import io
import sys
import traceback
from contextlib import redirect_stdout

STEPS = [
    ("backfill_fein", "Match unmatched DSPs to prod employers"),
    ("populate_work_locations", "Refresh work locations from prod"),
    ("populate_data_coverage", "Refresh payment-method / emergency-contact coverage"),
]


def run_step(module_name):
    """Import and run a step, capturing its output so the summary stays readable.
    Each step is independent: one failing must not stop the others."""
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            mod = __import__(module_name)
            mod.main()
        return True, buf.getvalue()
    except Exception:
        return False, buf.getvalue() + "\n" + traceback.format_exc()


def main():
    print("=" * 70)
    print("DSP Ops - prod refresh")
    print("=" * 70)

    failures = 0
    for name, desc in STEPS:
        print(f"\n>>> {desc}  ({name})")
        ok, output = run_step(name)
        tail = [l for l in output.strip().splitlines() if l.strip()]
        for line in tail[-12:]:
            print("    " + line)
        if not ok:
            failures += 1
            print(f"    !! {name} FAILED")

    print("\n" + "=" * 70)
    print(f"Done. {len(STEPS) - failures}/{len(STEPS)} steps succeeded.")
    print("=" * 70)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
