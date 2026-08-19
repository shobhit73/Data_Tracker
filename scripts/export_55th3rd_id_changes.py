"""Export every 55th & 3rd LLC employee whose ext_employee_code was changed.

One row per employee: current ID, the ID it was created with, who changed it
and when. Source is the Envers audit trail in cp_phix_prod1 - employee_aud
holds every revision, revision_information holds the actor + timestamp. The
live employee table only carries the latest value, which is why a search for
an old code like URRYMAEXM finds nothing there.

"Changed" = the code on the INSERT revision (revtype 0) differs from the code
on the row today. The change moment is the first revision whose code equals
today's value.

Actor names: revision_information.username stores an Auth0-style UUID for
logged-in users, not a name. Those UUIDs resolve through employee.user_id
where the actor happens to be an employee. Anything that does not resolve is
labelled 'Unresolved' rather than guessed - user_profile keys on a bigint
user_id and user_provider on 'auth0|<login>', so neither maps this UUID.

Read-only. Writes data/55th-3rd-employee-id-changes.csv.
"""
import csv
import os
import re

import pq_helper

EMPLOYER_ID = 2161266154
OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "55th-3rd-employee-id-changes.csv")

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

SQL = f"""
select e.id as uzio_internal_id,
       e.full_name,
       e.ext_employee_code as current_employee_id,
       orig.ext_employee_code as original_employee_id,
       ri.username as changed_by,
       ri.audit_date as changed_on,
       e.deleted
from cp_phix_prod1.employee e
join (select a.id, min(a.rev) as chg_rev
        from cp_phix_prod1.employee_aud a
        join cp_phix_prod1.employee e2 on e2.id = a.id
       where e2.employer_organization_id = {EMPLOYER_ID}
         and a.revtype = 1
         and a.ext_employee_code = e2.ext_employee_code
       group by a.id) t on t.id = e.id
join cp_phix_prod1.revision_information ri on ri.id = t.chg_rev
join (select a0.id, a0.ext_employee_code
        from cp_phix_prod1.employee_aud a0
       where a0.revtype = 0) orig on orig.id = e.id
where e.employer_organization_id = {EMPLOYER_ID}
  and orig.ext_employee_code is not null
  and orig.ext_employee_code <> e.ext_employee_code
order by ri.audit_date, e.full_name
"""

COLUMNS = ["full_name", "current_employee_id", "original_employee_id",
           "changed_by_name", "changed_by", "changed_on",
           "uzio_internal_id", "deleted"]


def resolve_actors(uuids):
    """Map actor UUID -> person name via employee.user_id, where it resolves."""
    if not uuids:
        return {}
    quoted = ",".join("'" + u + "'" for u in sorted(uuids))
    status, body = pq_helper.run(
        "select user_id, full_name, employer_organization_id "
        f"from cp_phix_prod1.employee where user_id in ({quoted})", size=50)
    if status != 200:
        print("  actor lookup failed - names left unresolved")
        return {}
    out = {}
    for r in body["data"]:
        suffix = (" (employee at this client)"
                  if r["employer_organization_id"] == EMPLOYER_ID else "")
        out[r["user_id"]] = r["full_name"] + suffix
    return out


def main():
    status, body = pq_helper.run(SQL.strip(), size=500)
    if status != 200:
        raise SystemExit(f"Query failed ({status}) - nothing written.")

    rows = body["data"]
    if body.get("hasMore"):
        print("WARNING: result was paginated - CSV is incomplete.")

    actors = {r["changed_by"] for r in rows}
    names = resolve_actors({a for a in actors if UUID_RE.match(a or "")})

    for a in sorted(actors):
        print(f"  actor {a} -> {names.get(a, 'UNRESOLVED')}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            actor = r.get("changed_by") or ""
            if actor == "SYSTEM":
                r["changed_by_name"] = "SYSTEM (automated, not a person)"
            elif "@" in actor:
                r["changed_by_name"] = actor
            else:
                r["changed_by_name"] = names.get(
                    actor, "Unresolved - Uzio-side login, no name on record")
            r["changed_on"] = (r.get("changed_on") or "").replace("T", " ")[:19]
            r["deleted"] = "yes" if r.get("deleted") == 1 else "no"
            w.writerow(r)

    print(f"\nwrote {len(rows)} rows -> {OUT}")


if __name__ == "__main__":
    main()
