"""Sync audit_coverage to Rohit Kaushik's daily 'Audit coverage' mail.

Source: the 08/18/2026 mail (message 1a01529b01ad3e44, subject
'Audit coverage - 9 of 14 clients need action - 08/18/2026').

The mail states, per client, how many of 6 audits are done and which are
PENDING. Present is therefore derived as "the 6 categories minus the pending
list" -- which is exactly what the mail's own 'Missing across all' tallies
cross-check to, so it is read from the mail, not inferred beyond it.

Declarative on purpose: the whole 14-client state is written out rather than
diffed against the previous day, so re-running is idempotent and the script
doubles as a record of what that mail actually said.

Client names are the ones ALREADY in the table, not the mail's spelling --
the table's unique key is (client_name, audit_category), so 'Express Package
System Inc' vs 'Express Package System Inc.' would silently create a second
client rather than update the existing one.
"""
import time

from supabase_helper import connect

CHECKED_DATE = "2026-08-18"
SOURCE_MESSAGE = "Audit coverage mail 08/18/2026"

CATEGORIES = [
    "Census", "Withholding", "Payment", "Prior Payroll",
    "Deduction", "Emergency Contact",
]

# client -> categories the mail lists as PENDING (everything else is Present).
AUDITED = {
    # 08/18: High Distinction graduated from 'Folder empty' to a real audited
    # client at 1/6 -- only Withholding cleared. Its stale Overall row is
    # deleted below, the same way Stave's was on 08/14.
    "High Distinction Logistics LLC": ["Census", "Payment", "Prior Payroll",
                                       "Deduction", "Emergency Contact"],
    "CDC LOGISTICS, LLC": ["Census", "Withholding", "Prior Payroll",
                           "Deduction", "Emergency Contact"],
    # Stave joined the audited set in the 08/14 mail at 1/6 (its stale
    # Overall/'Folder empty' row is deleted below); 08/15 moved it to 3/6 --
    # Withholding and Deduction cleared. 08/16-08/18 hold at 3/6.
    "Stave Delivery": ["Census", "Payment", "Emergency Contact"],
    "North Star Parcel LLC": ["Census"],
    # The 5 'complete' clients. 08/15 took Spelman to 5/6 (Payment cleared);
    # 08/18 clears its last Census gap, and Lazo's, so both reach 6/6 -- both
    # drop off the mail's audit-gaps list entirely.
    "Spelman Logistics Inc": [],
    "Lazo Logistics LLC": [],
    "First Line Logistics": [],
    "Flash Hub Delivery": [],
    "InnovDel Inc": [],
}

# 'Needs attention' clients - tracked as one Overall row, not 6 categories.
# 08/18: down to 5 -- High Distinction moved out into AUDITED above.
NEEDS_ATTENTION = {
    "Trek Delivery": "Folder empty",
    "Always More Logistics": "Folder empty",
    "Beck Logistics LLC": "Folder empty",
    "Kynect Express LLC": "No Audit Files folder",
    "Express Package System Inc.": "No Audit Files folder",
}

# Overall rows whose existing note is a hand-written caveat richer than the
# mail's generic reason - passing the generic text would overwrite it.
# (Category rows never need listing here: they always write notes=NULL, and the
# upsert's coalesce already preserves whatever is there - which is how the
# InnovDel/Census naming-mismatch caveat survives each refresh.)
STICKY_NOTES = {
    ("Kynect Express LLC", "Overall"),
}

UPSERT = """
insert into audit_coverage
  (client_name, audit_category, status, checked_date, source, notes)
values (%s, %s, %s, %s, %s, %s)
on conflict (client_name, audit_category) do update set
  status = excluded.status,
  checked_date = excluded.checked_date,
  source = excluded.source,
  -- notes: the mail never carries them, so an existing hand-written caveat
  -- must win over this script's NULL.
  notes = coalesce(excluded.notes, audit_coverage.notes),
  updated_at = now()
"""


def connect_with_retry(attempts=4):
    """The Supabase pooler intermittently resets a fresh connection."""
    for i in range(attempts):
        try:
            return connect()
        except Exception as exc:  # noqa: BLE001 - retry any connect failure
            if i == attempts - 1:
                raise
            print(f"  connect retry {i + 1}: {type(exc).__name__}")
            time.sleep(4)


def main():
    conn = connect_with_retry()
    cur = conn.cursor()

    cur.execute("select client_name, audit_category, status from audit_coverage")
    before = {(r[0], r[1]): r[2] for r in cur.fetchall()}

    changes, unchanged = [], 0

    for client, pending in AUDITED.items():
        for cat in CATEGORIES:
            status = "Missing" if cat in pending else "Present"
            # notes always NULL: the mail carries none, and coalesce in the
            # upsert keeps any caveat already recorded against this row.
            cur.execute(UPSERT, (client, cat, status, CHECKED_DATE,
                                 "email", None))
            prev = before.get((client, cat))
            if prev is None:
                changes.append(f"ADDED   {client} / {cat}: {status}")
            elif prev != status:
                changes.append(f"CHANGED {client} / {cat}: {prev} -> {status}")
            else:
                unchanged += 1

    for client, reason in NEEDS_ATTENTION.items():
        note = None if (client, "Overall") in STICKY_NOTES else reason
        cur.execute(UPSERT, (client, "Overall", "Not applicable",
                             CHECKED_DATE, "email", note))
        prev = before.get((client, "Overall"))
        if prev is None:
            changes.append(f"ADDED   {client} / Overall: Not applicable ({reason})")
        elif prev != "Not applicable":
            changes.append(f"CHANGED {client} / Overall: {prev} -> Not applicable")
        else:
            unchanged += 1

    # A client that graduates from 'Folder empty'/'No Audit Files folder' into
    # the audited set keeps a stale Overall row that now contradicts its 6
    # category rows. Stave hit this on 08/14 and High Distinction on 08/18, so
    # it is driven off AUDITED rather than hardcoded per client. Still a scoped
    # delete - only Overall rows, only for clients the mail now audits.
    for client in AUDITED:
        cur.execute(
            "delete from audit_coverage "
            "where client_name = %s and audit_category = 'Overall'",
            (client,),
        )
        if cur.rowcount:
            changes.append(
                f"DELETED {client} / Overall "
                f"(no longer 'needs attention' - now audited)"
            )

    conn.commit()

    print(f"Audit coverage synced to the {CHECKED_DATE} mail ({SOURCE_MESSAGE})")
    for line in changes:
        print("  " + line)
    print(f"  ({unchanged} rows re-confirmed unchanged)")

    cur.execute("select count(*), max(checked_date) from audit_coverage")
    print("audit_coverage rows now: %s, checked_date: %s" % cur.fetchone())
    cur.execute("select status, count(*) from audit_coverage group by 1 order by 2 desc")
    print("Status breakdown:", cur.fetchall())

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
