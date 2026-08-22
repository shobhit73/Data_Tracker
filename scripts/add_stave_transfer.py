"""Add the Stave Delivery row to document_transfer.

Stave's 19 Aug 2026 upload never had a row here, so the Documents view showed
"no transfer mail" against a client that had in fact just received 9,395
documents. The summary mail to Mercedes Hallback on 20 Aug 2026 (Document
Upload Status thread, 19e87c8359be7407) closes that gap.

Numbers come from the upload log analysis workbook attached to that mail
(Stave_Delivery_Document_Upload_Analysis.xlsx), not from estimates:
    9,427 files processed | 9,395 uploaded | 32 failed

total_docs is files PROCESSED, matching how the existing rows are recorded
(Spelman: 5,366 total / 869 failed, of which 4,497 uploaded).

failed_docs stays at the 32 the run actually produced rather than the 1 still
outstanding today. This table records the transfer event; the current state
lives in client_document_counts, counted off prod. The notes carry the
reconciliation between the two.

Upserts with coalesce like the other document_transfer writers, so re-running
can only add detail and never blanks a column filled in by hand.
"""
import sys

from supabase_helper import connect

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

THREAD = "19e87c8359be7407"

# 'Stave Delivery' and not the prod company_name 'Stave Delivery LLC': the
# dashboard joins this table to client_overview.dsp_name, which is the shorter
# form. sameClient() would match either, but staying on dsp_name keeps the row
# consistent with how audit_coverage names the same client.
CLIENT = "Stave Delivery"

NOTES = (
    "Paycom to Uzio migration, uploaded 19 Aug 2026 (11:41-18:17). Upload log: "
    "9,427 files processed, 9,395 uploaded, 32 failed. The 32 were 23 'employee "
    "not found' (ExtIds 0297, 8153, 2008), 8 unsupported .htm files (ExtId 2167, "
    "all verified duplicates of PDFs already uploaded), and 1 rejected for "
    "exceeding the 50 MB API limit (the USCIS I-9 for GREG MARTINEZ, ExtId 1870). "
    "31 of the 32 were cleared on 20 Aug. 0297 (James Futrell) and 8153 (Brian "
    "Akers) both DO exist in Uzio and uploaded on re-run without the client "
    "creating anything - the log's 'employee not found' was a fetch gap, the tool "
    "read 1,005 employee records against 1,007 in prod, a difference of exactly "
    "those two. 1870's I-9 uploaded once recompressed. Only ExtId 2008 remains: a "
    "single generic Employee Handbook for an ID genuinely absent from the Uzio "
    "employee master. The 9-document gap between the 9,427 reported here and the "
    "9,418 counted in prod is the 8 .htm duplicates plus 2008's file. Summary mail "
    "to Mercedes Hallback 20 Aug 2026 raised the pre-Feb-2022 leavers and the 9 "
    "recent new hires; the ExtId 2008 question was not included in it."
)

ROW = (CLIENT, "Completed with issues", "2026-08-19",
       9427, 32,
       None,   # fail_filename_format - no such failures in this run
       23,     # fail_employee_not_found
       8,      # fail_unsupported_type
       NOTES, THREAD)

SQL = """
insert into document_transfer
  (client_name, status, transfer_date, total_docs, failed_docs,
   fail_filename_format, fail_employee_not_found, fail_unsupported_type,
   notes, source_message_id)
values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
on conflict (client_name) do update set
  status = coalesce(excluded.status, document_transfer.status),
  transfer_date = coalesce(excluded.transfer_date, document_transfer.transfer_date),
  total_docs = coalesce(excluded.total_docs, document_transfer.total_docs),
  failed_docs = coalesce(excluded.failed_docs, document_transfer.failed_docs),
  fail_filename_format = coalesce(excluded.fail_filename_format, document_transfer.fail_filename_format),
  fail_employee_not_found = coalesce(excluded.fail_employee_not_found, document_transfer.fail_employee_not_found),
  fail_unsupported_type = coalesce(excluded.fail_unsupported_type, document_transfer.fail_unsupported_type),
  notes = coalesce(excluded.notes, document_transfer.notes),
  source_message_id = coalesce(excluded.source_message_id, document_transfer.source_message_id),
  updated_at = now()
"""


def main():
    conn = connect()
    cur = conn.cursor()

    cur.execute("select count(*) from document_transfer")
    before = cur.fetchone()[0]

    cur.execute("select status, transfer_date from document_transfer "
                "where client_name = %s", (CLIENT,))
    prev = cur.fetchone()

    cur.execute(SQL, ROW)
    conn.commit()

    cur.execute("select count(*) from document_transfer")
    after = cur.fetchone()[0]

    if prev:
        print(f"UPDATED {CLIENT}: {prev[0]} {prev[1]} -> {ROW[1]} {ROW[2]}")
    else:
        print(f"ADDED   {CLIENT}: {ROW[1]} {ROW[2]}")
    print(f"document_transfer rows: {before} -> {after}")

    cur.execute(
        "select client_name, status, transfer_date, total_docs, failed_docs, "
        "fail_employee_not_found, fail_unsupported_type, source_message_id "
        "from document_transfer where client_name = %s", (CLIENT,))
    print("\nROW:", cur.fetchone())

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
