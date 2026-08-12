"""Upsert document_transfer rows from the Gmail thread 'Document Upload Status'
(thread 19e87c8359be7407, 18 messages, Jun 2 - Aug 4 2026).

The table already held rows sourced from an EARLIER thread (transfers dated
April-May 2026). This script only adds/corrects the clients reported in the
'Document Upload Status' thread; it leaves every other row alone.

Every number here is quoted directly from a message in that thread -- nothing
is inferred. Where a message gave no count, the column stays NULL rather than
being guessed at.
"""
from supabase_helper import connect

THREAD = "19e87c8359be7407"

# (client_name, status, transfer_date, total, failed,
#  fail_filename_format, fail_employee_not_found, fail_unsupported_type, notes)
ROWS = [
    # Msg 6+7 (2026-07-08): "North Star Parcel Documents are uploaded successfully
    # without any errors" -- msg 6 mistakenly said Success=0, corrected in msg 7.
    ("North Star Parcel LLC", "Complete", "2026-07-08", 943, 0, None, None, None,
     "943 documents, all uploaded, no failures. A first mail reported Success=0 by "
     "mistake and was corrected minutes later in the same thread."),

    # Msg 10 (2026-07-16) + msgs 12-14 (retry outcome).
    ("Spelman Logistics Inc", "Completed with issues", "2026-07-16", 5366, 869, 808, 56, 3,
     "5,366 files, 4,497 uploaded (84%), 869 not uploaded (16%). Breakdown: 808 "
     "company-wide documents with no employee to file them under (I-9 doc list, "
     "punch-change and schedule guides, benefit/privacy/safe-harbor notices, DASH "
     "ordering guide); 56 for terminated/unknown employees; 3 format issues (2 .ZIP, "
     "1 old .DOC); 2 system errors. Retry on 07/21 uploaded Amauri Calderon Rivera "
     "and Evelyn Sepulveda successfully; 'Darth Vader' was not found in Uzio and the "
     "implementer confirmed it is a test account. Open question raised with the "
     "client and not yet answered in this thread: should company-wide docs sit on "
     "each employee profile or stay company-level."),

    # Msg 15 (2026-07-24). Supersedes the stale 'In progress / 2026-07-23' row.
    ("Lazo Logistics LLC", "Complete", "2026-07-24", 2073, 0, None, None, None,
     "2,073 documents, all uploaded successfully, no failures recorded."),

    # Msg 16 (2026-08-04).
    ("Flash Hub Delivery", "Complete", "2026-08-04", 2280, 0, None, None, None,
     "2,280 documents, all uploaded successfully, no failures recorded."),
]

SQL = """
insert into document_transfer
  (client_name, status, transfer_date, total_docs, failed_docs,
   fail_filename_format, fail_employee_not_found, fail_unsupported_type,
   notes, source_message_id)
values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
on conflict (client_name) do update set
  status = excluded.status,
  transfer_date = excluded.transfer_date,
  total_docs = excluded.total_docs,
  failed_docs = excluded.failed_docs,
  fail_filename_format = excluded.fail_filename_format,
  fail_employee_not_found = excluded.fail_employee_not_found,
  fail_unsupported_type = excluded.fail_unsupported_type,
  notes = excluded.notes,
  source_message_id = excluded.source_message_id,
  updated_at = now()
"""

if __name__ == "__main__":
    conn = connect()
    cur = conn.cursor()

    cur.execute("select client_name, status, transfer_date from document_transfer")
    before = {r[0]: (r[1], r[2]) for r in cur.fetchall()}

    for r in ROWS:
        cur.execute(SQL, r + (THREAD,))
    conn.commit()

    for r in ROWS:
        name = r[0]
        if name in before:
            print(f"UPDATED {name}: {before[name][0]} {before[name][1]} -> {r[1]} {r[2]}")
        else:
            print(f"ADDED   {name}: {r[1]} {r[2]}")

    cur.execute("select count(*) from document_transfer")
    print("\ndocument_transfer rows now:", cur.fetchone()[0])
    cur.close()
    conn.close()
