"""Record the Stave re-run outcome so the page tells the whole story.

The Document Transfer card was showing "Failed 32" with the resolution buried
in a wall of prose, which reads as "32 documents are still broken" when in fact
31 of them were cleared the next day. Two additive columns fix that:

    failed_resolved  - how many of the first run's failures have since cleared
    fail_size_limit  - the HTTP 412 over-50MB bucket, which had no column, so
                       the breakdown summed to 31 of 32 and quietly lost one

Both are nullable and every other row stays NULL, so nothing else changes.

Notes move from one paragraph to newline-separated points; the renderer splits
on newline and falls back to a paragraph for the single-line rows, so the older
clients are unaffected.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CLIENT = "Stave Delivery"
DRIVE_URL = "https://drive.google.com/drive/folders/1kqrQdS64zj0bRnyCv9amCA2XA5U6W9jh"

DDL = """
alter table document_transfer add column if not exists failed_resolved integer;
alter table document_transfer add column if not exists fail_size_limit integer;
"""

# One point per line. Kept short on purpose - this renders as a bullet list.
NOTES = "\n".join([
    "First run 19 Aug 2026 (11:41-18:17): 9,427 files processed, 9,395 uploaded, 32 failed.",
    "Re-run 20 Aug cleared 31 of the 32. Only ExtId 2008 is still outstanding.",
    "0297 James Futrell and 8153 Brian Akers (22 docs) - both DO exist in Uzio. "
    "The log's 'employee not found' was a tool fetch gap: it read 1,005 employee "
    "records against 1,007 in prod, a difference of exactly those two. Both "
    "uploaded on re-run, with nothing created by the client.",
    "1870 Greg Martinez - his USCIS I-9 was rejected for exceeding the 50 MB API "
    "limit. Uploaded once recompressed; it was the only I-9 he was missing.",
    "2167 Paul Bridgeman - 8 .htm files rejected as unsupported, all verified "
    "duplicates of PDFs already uploaded. No action needed.",
    "2008 - one generic Employee Handbook for an ID genuinely absent from the "
    "Uzio employee master. Still open, and not raised in the 20 Aug summary mail.",
    "9,427 processed vs 9,418 now counted in prod: the 9 are the 8 .htm "
    "duplicates plus 2008's file.",
])

UPDATE = """
update document_transfer set
  failed_resolved = %s,
  fail_size_limit = %s,
  fail_employee_not_found = %s,
  fail_unsupported_type = %s,
  drive_folder_url = %s,
  notes = %s,
  updated_at = now()
where client_name = %s
"""


def main():
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()

    for stmt in DDL.strip().split(";"):
        if stmt.strip():
            cur.execute(stmt)
    print("columns ensured: failed_resolved, fail_size_limit")

    conn.autocommit = False

    cur.execute("select failed_docs, failed_resolved, drive_folder_url "
                "from document_transfer where client_name = %s", (CLIENT,))
    before = cur.fetchone()
    if not before:
        raise SystemExit(f"No document_transfer row for {CLIENT!r}.")
    print("before:", before)

    # 23 + 8 + 1 = 32, so the breakdown now accounts for every failure.
    cur.execute(UPDATE, (31, 1, 23, 8, DRIVE_URL, NOTES, CLIENT))
    if cur.rowcount != 1:
        conn.rollback()
        raise SystemExit(f"Update touched {cur.rowcount} rows - rolled back.")
    conn.commit()

    cur.execute(
        "select failed_docs, failed_resolved, fail_employee_not_found, "
        "fail_unsupported_type, fail_size_limit, drive_folder_url "
        "from document_transfer where client_name = %s", (CLIENT,))
    row = cur.fetchone()
    print("after :", row[:5])
    print("drive :", row[5])

    total_breakdown = (row[2] or 0) + (row[3] or 0) + (row[4] or 0)
    print(f"breakdown sums to {total_breakdown} of {row[0]} failures "
          f"({'ok' if total_breakdown == row[0] else 'MISMATCH'})")
    print(f"outstanding: {row[0] - row[1]}")

    cur.execute("select notes from document_transfer where client_name = %s", (CLIENT,))
    print("\nnote points:")
    for line in cur.fetchone()[0].split("\n"):
        print("  - " + line[:88])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
