"""Add the employee-coverage detail from the 20 Aug 2026 'Document Upload
Status' mail to Stave Delivery's document_transfer row.

Source: message 1a01e74308848eec (2026-08-20, thread 19e87c8359be7407).

The row already carries the full first-run/re-run failure story from
track_stave_rerun.py, and that reconciliation is deliberate and hand-checked --
so this script does NOT touch total_docs, failed_docs, the failure breakdown,
status or transfer_date. It only fills the one column the mail speaks to and
that is still NULL (employees_skipped = the 164 employees with no documents),
and appends the mail's own figures as extra note points.

Numbers are quoted from the mail, never inferred. The mail's "9,417 uploaded"
is recorded as the mail's figure alongside the 9,418 that populate_document_counts
actually counts in prod -- the one-document gap is left visible for a human
rather than reconciled away here.

Idempotent: the note points are appended only if they are not already present.
"""
from supabase_helper import connect

CLIENT = "Stave Delivery"
SOURCE_MESSAGE = "1a01e74308848eec"

# One point per line, matching the bullet-list shape track_stave_rerun.py set up.
NEW_POINTS = [
    "20 Aug summary mail to the implementer: 9,417 documents uploaded, "
    "covering 843 employees. populate_document_counts counts 9,418 in prod - "
    "the one-document difference is unexplained and worth a human check.",
    "164 employees have no documents at all: 155 left between June 2019 and "
    "February 2022 and their documents never came across from Paycom, and 9 "
    "are new hires who joined 10-18 Aug and have none yet.",
    "Two questions are open with the client (attachment "
    "stave_zero_doc_employees.csv): whether the pre-Feb-2022 leavers' documents "
    "exist on their side, and whether the 9 new joiners' documents will be sent "
    "or collected directly in Uzio. Not yet answered in the thread.",
]

MARKER = "164 employees have no documents at all"


def main():
    conn = connect()
    cur = conn.cursor()

    cur.execute(
        "select employees_skipped, notes, source_message_id "
        "from document_transfer where client_name = %s", (CLIENT,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"No document_transfer row for {CLIENT!r}.")
    skipped_before, notes_before, src_before = row
    print("before: employees_skipped=%s, note points=%d"
          % (skipped_before, len(notes_before.split("\n")) if notes_before else 0))

    if MARKER in (notes_before or ""):
        print("Note points already present - nothing appended.")
        notes_after = notes_before
    else:
        notes_after = "\n".join([notes_before] + NEW_POINTS) if notes_before \
            else "\n".join(NEW_POINTS)

    cur.execute(
        """
        update document_transfer set
          -- coalesce: only fill employees_skipped if nobody has set it by hand
          employees_skipped = coalesce(employees_skipped, %s),
          notes = %s,
          source_message_id = %s,
          updated_at = now()
        where client_name = %s
        """,
        (164, notes_after, SOURCE_MESSAGE, CLIENT),
    )
    if cur.rowcount != 1:
        conn.rollback()
        raise SystemExit(f"Update touched {cur.rowcount} rows - rolled back.")
    conn.commit()

    cur.execute(
        "select employees_skipped, total_docs, failed_docs, failed_resolved, "
        "status, transfer_date, notes from document_transfer "
        "where client_name = %s", (CLIENT,))
    a = cur.fetchone()
    print("after : employees_skipped=%s, total_docs=%s, failed_docs=%s, "
          "failed_resolved=%s, status=%s, transfer_date=%s"
          % a[:6])
    print("\nnote points:")
    for line in a[6].split("\n"):
        print("  - " + line[:88])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
