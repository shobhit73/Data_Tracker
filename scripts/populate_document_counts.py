"""How many employee documents each client actually has in Uzio, from prod.

WHY THIS EXISTS
    The Documents view is built from the transfer-completion mails, and those
    mails are an unreliable narrator: several say "completed successfully" and
    give no count at all (InnovDel, JDW, Skyland all show a blank total), one
    reported Success=0 and corrected itself minutes later, and none of them can
    say what is in the system *now* rather than what was uploaded that day.
    This counts the rows instead, so "the mail said it worked" and "the
    documents are there" become two separate, comparable facts.

WHERE EMPLOYEE DOCUMENTS LIVE
    Not in employee_document, which is empty in all of prod, nor in
    document_detail, which holds org-level report exports and profile pictures.
    They are rows in `form` with category = 'EMPLOYEE_DOC', joined to the
    employee by form.user_organization_id = employee.employee_code -- a varchar
    UUID, not the numeric employee.id. (Learned from the SQL attached to
    PRODINT-10238; see .claude/docs/prod-table-lookup-gotchas.md.)

A COUNT IS A SNAPSHOT, NOT A VERDICT
    The upload API runs for hours: Stave was mid-run at 7,576 documents across
    696 of its 1,005 employees while this was being written. So the number is
    "as at checked_at", and a client can legitimately be half-loaded. That is
    also why employees_with_docs is stored next to the document total -- 900
    documents spread over 90 employees is a very different state from the same
    900 over 300, and the ratio is what shows a run that stopped early.

Run:  python populate_document_counts.py
Writes only client_document_counts.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pq_helper
from supabase_helper import connect

# Only a real console stream can be reconfigured. refresh_prod.py runs each step
# under redirect_stdout(StringIO), which has no .reconfigure -- guarding here
# stops that runner from losing this step entirely on every scheduled run.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AMAZON_EXCHANGE = "EX-20243277-1b50-4035-821d-d0fcd9b895a9"

DDL = """
create table if not exists client_document_counts (
    dsp_short_code      text primary key references client_overview(dsp_short_code) on delete cascade,
    fein                text,
    company_name        text,
    documents           integer not null default 0,
    employees_with_docs integer not null default 0,
    total_employees     integer not null default 0,
    active_employees    integer not null default 0,
    checked_at          timestamptz not null default now()
);
grant select on client_document_counts to anon, authenticated;
"""

DOCS_SQL = """
select replace(coalesce(eo.fein,''),'-','') as fein_norm,
       eo.company_name,
       count(*) as documents,
       count(distinct f.user_organization_id) as employees_with_docs
from employer_organization eo
join employee e on e.employer_organization_id = eo.id and e.deleted = 0
join form f on f.user_organization_id = e.employee_code
           and f.category = 'EMPLOYEE_DOC' and f.deleted = 0
where eo.exchange_id = '%s' and eo.deleted = 0
group by 1, 2
order by 1
""" % AMAZON_EXCHANGE

# Separate query on purpose: joining headcount into the document count would
# multiply one by the other, and an inner join would drop every client that has
# no documents yet -- which are exactly the ones worth seeing.
STAFF_SQL = """
select replace(coalesce(eo.fein,''),'-','') as fein_norm,
       eo.company_name,
       count(*) as total_employees,
       count(*) filter (where e.date_of_termination is null) as active_employees
from employer_organization eo
join employee e on e.employer_organization_id = eo.id and e.deleted = 0
where eo.exchange_id = '%s' and eo.deleted = 0
group by 1, 2
order by 1
""" % AMAZON_EXCHANGE


def pq(sql, size=2000):
    """Read every page; a partial read here would silently under-count."""
    jwt = pq_helper.get_jwt()
    rows, page = [], 0
    while True:
        status, body = pq_helper.post(
            pq_helper.GATEWAY + "/api/neuronops/query",
            {"sql": sql, "size": size, "page": page},
            {"Authorization": "Bearer " + jwt, "X-Auth-Type": "bearer"})
        if status != 200:
            raise SystemExit(f"prod query failed: HTTP {status} {body}")
        rows.extend(body["data"])
        if not body.get("hasMore"):
            return rows
        page += 1


def main():
    docs = {r["fein_norm"]: r for r in pq(DOCS_SQL) if r["fein_norm"]}
    staff = {r["fein_norm"]: r for r in pq(STAFF_SQL) if r["fein_norm"]}
    print(f"prod: {len(staff)} employers, {len(docs)} of them with documents")

    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(DDL)

    cur.execute("select dsp_short_code, fein from client_overview where fein is not null")
    code_by_fein = {fein.replace("-", ""): code for code, fein in cur.fetchall()}

    rows, unmatched = [], []
    for fein, s in staff.items():
        code = code_by_fein.get(fein)
        if not code:
            unmatched.append((fein, s["company_name"], (docs.get(fein) or {}).get("documents", 0)))
            continue
        d = docs.get(fein) or {}
        rows.append((code, fein, s["company_name"],
                     d.get("documents", 0), d.get("employees_with_docs", 0),
                     s["total_employees"], s["active_employees"]))

    cur.executemany(
        "insert into client_document_counts (dsp_short_code, fein, company_name, documents, "
        "employees_with_docs, total_employees, active_employees, checked_at) "
        "values (%s,%s,%s,%s,%s,%s,%s, now()) "
        "on conflict (dsp_short_code) do update set "
        "fein=excluded.fein, company_name=excluded.company_name, documents=excluded.documents, "
        "employees_with_docs=excluded.employees_with_docs, total_employees=excluded.total_employees, "
        "active_employees=excluded.active_employees, checked_at=now()",
        rows)
    print(f"{len(rows)} clients written")

    if unmatched:
        print(f"\n{len(unmatched)} prod employers not matched to a DSP row "
              "(no FEIN on the tracker side, or a test employer):")
        for fein, name, n in sorted(unmatched, key=lambda x: -x[2]):
            print(f"  {fein or '(none)':11} {n:>6} docs  {name[:44]}")

    cur.execute("""
        select d.dsp_short_code, d.company_name, d.documents, d.employees_with_docs,
               d.total_employees
        from client_document_counts d order by d.documents desc""")
    all_rows = cur.fetchall()
    total = sum(r[2] for r in all_rows)
    none = [r for r in all_rows if r[2] == 0]
    print(f"\n{total:,} employee documents across {len(all_rows)} clients; "
          f"{len(none)} clients have none")
    print(f"\n{'code':6} {'docs':>7} {'employees':>16}  client")
    for code, name, docs_n, withd, tot in all_rows[:15]:
        print(f"{code:6} {docs_n:>7,} {withd:>7,} / {tot:<6,}  {name[:38]}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
