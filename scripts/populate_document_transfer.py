"""Create + populate document_transfer from the Gmail document-transfer thread history.

Source: Gmail threads read manually this session (read-only — nothing was sent
or modified):
  - "Document Upload Status"          (thread 19e87c8359be7407)
  - "EE Document Upload Summary – <client>"  (per-client, detailed failure breakdown)
  - "Regarding Document Upload"       (thread 19d965532b154906)
  - "Document Access from ADP - Lazo Logistics LLC" (thread 19f6b333eb445aa2)

Counts are taken verbatim from those mails. Where a mail reported "documents for
N employees were skipped" rather than a document count, that goes in
employees_skipped — NOT failed_docs — because the two are not the same unit and
conflating them would overstate the failure rate.
"""
from supabase_helper import connect

SCHEMA = """
create table if not exists document_transfer (
    id                          bigint generated always as identity primary key,
    client_name                 text not null unique,
    status                      text not null,
    transfer_date               date,
    total_docs                  integer,
    failed_docs                 integer,
    employees_skipped           integer,
    fail_filename_format        integer,
    fail_employee_not_found     integer,
    fail_unsupported_type       integer,
    jira_id                     text,
    drive_folder_url            text,
    notes                       text,
    source_message_id           text,
    updated_at                  timestamptz not null default now()
);
"""

GRANTS = """
alter table document_transfer enable row level security;
drop policy if exists "anon_read_only" on document_transfer;
create policy "anon_read_only" on document_transfer for select to anon using (true);
grant select on document_transfer to anon, authenticated;
"""

# status vocabulary: Complete / Completed with issues / Blocked / In progress / Nothing to transfer
ROWS = [
    dict(client_name="JM Parcel Service", status="Complete", transfer_date="2026-04-15",
         drive_folder_url="https://drive.google.com/drive/folders/1JKqL_CYmkFd88i5xUDAi9VBzUwnFu1sh",
         notes="Transfer completed; downloaded docs also filed into the DSP folder.",
         source_message_id="19d965532b154906"),

    dict(client_name="MARK Logistics, LLC", status="Completed with issues", transfer_date="2026-04-16",
         employees_skipped=1336, jira_id="PHIX-97100",
         drive_folder_url="https://drive.google.com/drive/folders/1prXHR8xRxElgOGWG6uaO4ACzWYyY_04t",
         notes="Skipped mostly for invalid filename format (expected prefix_employeeExtId_documentName). "
               "One employee (A11G Kirstie Faught) deliberately excluded — terminated, Candace instructed not to upload.",
         source_message_id="19d965532b154906"),

    dict(client_name="Falcon Express Logistics", status="Completed with issues", transfer_date="2026-04-17",
         employees_skipped=297, jira_id="PHIX-97115",
         drive_folder_url="https://drive.google.com/drive/folders/1pW0-FV1cRiw4r4gj4xesnTIt54wYaNWr",
         notes="Two employees (A012 ARIAS YENIFER, A09B PORTILLO-DEAVALOS LEYDI) not found in Uzio — duplicate SSNs "
               "exist under different IDs. Rest skipped because docs are named \"I9 Documents\" with no employee code.",
         source_message_id="19d9b5f707a97850"),

    dict(client_name="Wheels for Work LLC", status="Completed with issues", transfer_date="2026-05-05",
         total_docs=11429, failed_docs=1002,
         fail_filename_format=852, fail_employee_not_found=143, fail_unsupported_type=1,
         notes="852 filename-format failures are Paycom system docs (not employee-signed) — no action needed. "
               "Of the 143 not-found, A2GE and A2G9 are ACTIVE on Paycom (hired 20 Apr, client went live 19 Apr) "
               "— these should exist in Uzio and need checking. 1 unsupported .mp4 (video of a passport).",
         source_message_id="19df7c64e0abe164"),

    dict(client_name="Accelerated Logistics Corp", status="Completed with issues", transfer_date="2026-05-08",
         total_docs=9270, failed_docs=1235,
         fail_filename_format=1156, fail_employee_not_found=75, fail_unsupported_type=4,
         notes="1,156 filename-format failures are company-level docs (I9DOCUMENTS, GUARANTEEDPAY) — not "
               "employee-signed, not required. All 75 not-found are terminated or never-hired. "
               "4 unsupported .jfif files hold an SSN card and a driver's licence image for A0H9.",
         source_message_id="19e0732f2aecd703"),

    dict(client_name="DNI Carriers LLC", status="Completed with issues", transfer_date="2026-05-13",
         total_docs=2095, failed_docs=402,
         fail_filename_format=372, fail_employee_not_found=28, fail_unsupported_type=2,
         notes="372 filename-format failures are generic company-level docs (ACCEPTABLEI9DOCS, "
               "MASSACHUSETTSEMPLOYEEHANDBOOK, EMPLOYEEPRIVACYNOTICE). 28 not-found across 3 never-hired IDs. "
               "2 unsupported .mp4 files.",
         source_message_id="19e20a1b6560160b"),

    dict(client_name="Caravan 12th Corporation", status="Complete", transfer_date="2026-06-02",
         notes="Uploaded successfully.", source_message_id="19e87cae94f70e1e"),

    dict(client_name="Fass Logistics LLC", status="Complete", transfer_date="2026-06-02",
         notes="Uploaded successfully.", source_message_id="19e87cae94f70e1e"),

    dict(client_name="Happy Delivery LLC", status="Complete", transfer_date="2026-06-10",
         notes="First run produced duplicate documents for some employees; utility re-run and completed clean. "
               "A separate request went to client.success to delete the duplicate upload (PHIX-98015, now closed).",
         jira_id="PHIX-98015", source_message_id="19eb05c0d1bc223c"),

    dict(client_name="Chief Delivery LLC", status="Completed with issues", transfer_date="2026-06-10",
         notes="Employer-level documents with no associated employee ID could not upload: Safety Bonus Plan, "
               "Data Privacy Notice, Vehicle/Biometric Consent, Onboarding Applications, Employee Health Plans, "
               "Employee Handbook, Medical Benefit Summary, dental/vision rate sheets.",
         source_message_id="19eb05c0d1bc223c"),

    dict(client_name="Hansen Brothers Delivery", status="Nothing to transfer", transfer_date="2026-06-10",
         total_docs=0,
         notes="No documents found on the client's portal to export.",
         source_message_id="19eb05c0d1bc223c"),

    dict(client_name="Skyland Logistics", status="Complete", transfer_date="2026-06-11",
         failed_docs=0, notes="Completed with no errors.", source_message_id="19eb687d456e4353"),

    dict(client_name="JDW Logistics", status="Complete", transfer_date="2026-07-03",
         failed_docs=0, notes="Completed with no errors. (Mail says \"JWD Logistics\" — matches JDW Logistics in the tracker.)",
         source_message_id="19f278c1a5273ba8"),

    dict(client_name="TRUDELO LLC", status="Blocked", transfer_date="2026-04-17",
         notes="Pending — unable to log in to ADP for Trudelo. Shruti also reported never receiving the passcode "
               "or credentials referenced in the tracker sheet.",
         source_message_id="19d9b5f707a97850"),

    dict(client_name="Lazo Logistics LLC", status="In progress", transfer_date="2026-07-23",
         notes="ADP access was lost mid-transfer and re-requested from the client; Gina's ADP credentials "
               "forwarded 23 Jul with instruction to proceed with the document transfer.",
         source_message_id="19f8fbb15da2c447"),

    dict(client_name="55th & 3rd LLC", status="In progress", transfer_date="2026-04-14",
         notes="Shruti flagged on 14 Apr that this is likely NOT complete despite the tracker column — "
               "last meeting's updates were never reflected. No completion mail has followed.",
         source_message_id="19d965532b154906"),
]

COLS = ["client_name","status","transfer_date","total_docs","failed_docs","employees_skipped",
        "fail_filename_format","fail_employee_not_found","fail_unsupported_type",
        "jira_id","drive_folder_url","notes","source_message_id"]

if __name__ == "__main__":
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(SCHEMA)
    cur.execute(GRANTS)

    placeholders = ", ".join(["%s"] * len(COLS))
    updates = ", ".join(f"{c} = excluded.{c}" for c in COLS if c != "client_name")
    sql = (f"insert into document_transfer ({', '.join(COLS)}) values ({placeholders}) "
           f"on conflict (client_name) do update set {updates}, updated_at = now()")
    for r in ROWS:
        cur.execute(sql, [r.get(c) for c in COLS])

    cur.execute("select status, count(*) from document_transfer group by status order by 2 desc")
    print("document_transfer by status:")
    for s, n in cur.fetchall():
        print(f"  {s}: {n}")
    cur.execute("select count(*), sum(total_docs), sum(failed_docs) from document_transfer")
    n, total, failed = cur.fetchone()
    print(f"rows: {n} | docs counted: {total} | failed: {failed}")
    cur.close()
    conn.close()
