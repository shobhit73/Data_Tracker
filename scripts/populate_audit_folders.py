"""Attach each audit client's Drive "Audit Files" folder to audit_coverage.

The audit rows say what is present or missing; without a link, checking one
means hunting through Drive for the client folder first. The folder ids were
resolved through the Drive connector (which lives in Claude, not in Python) by
listing every folder titled "Audit Files" and matching its parent against the
client folders under Amazon DSP, so they are pinned here rather than rediscovered.

Two of the fourteen have no such folder at all — Kynect Express and Express
Package System. That is not an oversight here: it is exactly what their existing
audit_coverage notes already say ("No Audit Files folder"), so finding nothing
for them corroborates the note rather than contradicting it. They are listed
below with None so the absence is explicit and a future run does not treat them
as simply unmapped.

Writes only audit_coverage.audit_folder_url. Never touches status, checked_date
or notes -- those belong to the daily mail sync (update_audit_from_mail.py).
"""
from supabase_helper import connect

FOLDER = "https://drive.google.com/drive/folders/"

# client_name exactly as stored in audit_coverage -> Audit Files folder id
AUDIT_FOLDERS = {
    "CDC LOGISTICS, LLC":             "1baLRJf1OUnbvIVwzgUodXGt2g5_h2trI",
    "Spelman Logistics Inc":          "1M5Akqk-u1x22ZY3ECtD7MlT-sBl5UHjk",
    "North Star Parcel LLC":          "1p6SmejTu0W1fL0AVGeFKEGEwNl6KX0Yl",
    "Trek Delivery":                  "1EzFwWeU4Juy-h8cKgERTx5jwY_QSEsKn",
    "InnovDel Inc":                   "13AHIucyeOZK9VC6OzCCs7PKa0v5_MQoP",
    "Lazo Logistics LLC":             "1G9GDoaXKTpIMYRO9aY2C2am7k9jvJT9O",
    "Always More Logistics":          "1VkP_mdheyPfjuKgjwmkmAi5SGnJ0Zj5W",
    "Stave Delivery":                 "1uPfkAx2VthcBTuShjuUXAQhy43DakXZF",
    "High Distinction Logistics LLC": "1QHfp8u6mKyJIR4GiBCmMxpM4S_yy0ngX",
    "Beck Logistics LLC":             "1myhJQ-XvOfQRG4IoC80lHQqlMcoH0Pae",
    "First Line Logistics":           "1UeQxwyj-QSJ0vLqoBc9Z7kluyyN1okzE",
    "Flash Hub Delivery":             "18qw6pWlSRqm_Clsp8tYyfkVx54uz9X8O",
    # No Audit Files folder exists in Drive for these two.
    "Kynect Express LLC":             None,
    "Express Package System Inc.":    None,
}


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute("alter table audit_coverage add column if not exists audit_folder_url text")
    conn.commit()

    cur.execute("select distinct client_name from audit_coverage")
    known = {r[0] for r in cur.fetchall()}

    linked = missing = unmapped = 0
    for client, fid in AUDIT_FOLDERS.items():
        if client not in known:
            print(f"  !! '{client}' is not in audit_coverage — skipped")
            continue
        if fid is None:
            missing += 1
            continue
        # One folder per client, but audit_coverage holds a row per category, so
        # every row for that client carries the same link.
        cur.execute(
            "update audit_coverage set audit_folder_url = %s, updated_at = now() "
            "where client_name = %s", (FOLDER + fid, client))
        linked += 1
    conn.commit()

    for client in sorted(known - set(AUDIT_FOLDERS)):
        print(f"  !! '{client}' in audit_coverage has no folder mapping here")
        unmapped += 1

    print(f"linked {linked} clients, {missing} have no Audit Files folder in Drive, "
          f"{unmapped} unmapped")

    cur.execute(
        "select count(distinct client_name) from audit_coverage where audit_folder_url is not null")
    print("clients now carrying an audit folder link:", cur.fetchone()[0])
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
