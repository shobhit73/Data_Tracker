"""Per-client data-coverage counts, straight from prod (read-only).

Answers "how many of this client's people actually have X yet" for the two
things we can count reliably today: a payment method and an emergency contact.

WHY THIS EXISTS
    The dashboard's API-activity view is fed by a manual onboarding-API export,
    which only says an API *ran*. It cannot say whether the run landed. Coverage
    is the complement: it is a straight count against prod, so it carries no
    inference and no error bar, and it surfaces the cases the API log hides --
    e.g. a client whose census API ran months ago but still has 0 payment
    methods.

ACTIVE vs TOTAL -- both are stored, on purpose
    Both denominators are recorded so the dashboard can switch between them:
      *_active_*  -> employees still on the books (date_of_termination is null)
      *_total_*   -> every non-deleted employee, terminated ones included
    They tell different stories and the gap between them is itself the signal.
    Wheels for Work has 2396 total but 172 active: "2396 of 2396 have a payment
    method" reads as a triumph when it is really a statement about people who
    left, while the active pair shows 172 of 172. Migration completeness wants
    the total pair; "is this client ready to run payroll" wants the active pair.
    Neither is derivable from the other, so both are counted here.

Run:  python populate_data_coverage.py
Writes only client_data_coverage. Never touches open_items or
historical_data_checklist (human-owned), nor api_activity_runs (manual).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pq_helper
from supabase_helper import connect

DDL = """
create table if not exists client_data_coverage (
  dsp_short_code text primary key,
  fein text,
  company_name text,
  total_employees integer,
  active_employees integer,
  total_with_payment_method integer,
  total_with_emergency_contact integer,
  active_with_payment_method integer,
  active_with_emergency_contact integer,
  total_with_licence integer,
  active_with_licence integer,
  checked_date date,
  updated_at timestamptz default now()
)
"""

# Added after the table already existed in some environments, so each column is
# introduced defensively rather than assuming a fresh create.
BACKFILL_COLS = [
    "total_with_payment_method integer",
    "total_with_emergency_contact integer",
    "total_with_licence integer",
    "active_with_licence integer",
]

# Driving licence arrives through the ADP/Paycom census as custom fields, not as
# a column on employee -- searching the schema for a licence column finds only
# the broker tables and utt_cortex_driver (the Amazon Cortex roster, which has
# no employee_id at all and so cannot be tied back to our employees). The census
# writes four keys; "License Number" is the one to count, since a row can exist
# with an empty value for employees whose licence was never captured.
LICENCE_KEY = "License Number"

UPSERT = """
insert into client_data_coverage
  (dsp_short_code, fein, company_name, total_employees, active_employees,
   total_with_payment_method, total_with_emergency_contact, total_with_licence,
   active_with_payment_method, active_with_emergency_contact, active_with_licence,
   checked_date)
values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,current_date)
on conflict (dsp_short_code) do update set
  fein = excluded.fein,
  company_name = excluded.company_name,
  total_employees = excluded.total_employees,
  active_employees = excluded.active_employees,
  total_with_payment_method = excluded.total_with_payment_method,
  total_with_emergency_contact = excluded.total_with_emergency_contact,
  total_with_licence = excluded.total_with_licence,
  active_with_payment_method = excluded.active_with_payment_method,
  active_with_emergency_contact = excluded.active_with_emergency_contact,
  active_with_licence = excluded.active_with_licence,
  checked_date = excluded.checked_date,
  updated_at = now()
"""


def fetch_prod_coverage(feins):
    """One aggregate per employer. The payment-method join goes through
    employee_code, which is a UUID in prod and therefore globally unique -- so
    it cannot pull in another employer's rows. Emergency contacts join on the
    employee id directly."""
    inlist = ",".join("'" + f + "'" for f in feins)
    sql = (
        "select replace(coalesce(eo.fein,''),'-','') as fein_norm, "
        "eo.company_name, "
        "count(distinct e.id) as total_employees, "
        "count(distinct case when e.date_of_termination is null then e.id end) "
        "  as active_employees, "
        "count(distinct case when pm.id is not null then e.id end) "
        "  as total_with_payment, "
        "count(distinct case when ec.id is not null then e.id end) "
        "  as total_with_emergency, "
        "count(distinct case when cf.id is not null then e.id end) "
        "  as total_with_licence, "
        "count(distinct case when e.date_of_termination is null "
        "  and pm.id is not null then e.id end) as active_with_payment, "
        "count(distinct case when e.date_of_termination is null "
        "  and ec.id is not null then e.id end) as active_with_emergency, "
        "count(distinct case when e.date_of_termination is null "
        "  and cf.id is not null then e.id end) as active_with_licence "
        "from employer_organization eo "
        "join employee e on e.employer_organization_id = eo.id and e.deleted = 0 "
        "left join employee_payment_method pm "
        "  on pm.employee_code = e.employee_code and pm.deleted = 0 "
        "left join emergency_contact ec "
        "  on ec.employee_id = e.id and ec.deleted = 0 "
        # A custom-field row can exist with an empty value, so the blank check
        # belongs in the join -- otherwise every employee with the key present
        # would count as having a licence.
        "left join employee_custom_fields cf "
        "  on cf.employee_id = e.id and cf.deleted = 0 "
        "  and cf.field_key = '" + LICENCE_KEY + "' "
        "  and nullif(trim(cf.field_value), '') is not null "
        "where eo.deleted = 0 "
        "and replace(coalesce(eo.fein,''),'-','') in (" + inlist + ") "
        "group by 1, 2"
    )
    jwt = pq_helper.get_jwt()
    status, body = pq_helper.post(
        pq_helper.GATEWAY + "/api/neuronops/query",
        {"sql": sql, "size": 2000},
        {"Authorization": "Bearer " + jwt, "X-Auth-Type": "bearer"},
    )
    if status != 200:
        print("prod-query failed:", status, body)
        sys.exit(1)
    print("prod-query HTTP 200, rows:", len(body["data"]),
          "hasMore:", body.get("hasMore"))
    return body["data"]


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute(DDL)
    for coldef in BACKFILL_COLS:
        cur.execute(f"alter table client_data_coverage add column if not exists {coldef}")
    conn.commit()

    cur.execute(
        "select dsp_short_code, fein from client_overview where fein is not null")
    code_by_fein = {fein: code for code, fein in cur.fetchall()}
    print(f"{len(code_by_fein)} DSPs in client_overview carry a fein")

    rows = fetch_prod_coverage(list(code_by_fein))

    written = 0
    no_payment, no_emergency, no_licence = [], [], []
    for r in rows:
        code = code_by_fein.get(r["fein_norm"])
        if not code:
            continue
        active = int(r["active_employees"])
        pay = int(r["active_with_payment"])
        emg = int(r["active_with_emergency"])
        lic = int(r["active_with_licence"])
        cur.execute(UPSERT, (code, r["fein_norm"], r["company_name"],
                             int(r["total_employees"]), active,
                             int(r["total_with_payment"]),
                             int(r["total_with_emergency"]),
                             int(r["total_with_licence"]),
                             pay, emg, lic))
        written += 1
        # Worth surfacing: a client with staff on the books and nothing loaded
        # for them is a real gap, not a rounding error.
        if active > 0 and pay == 0:
            no_payment.append((r["company_name"], active))
        if active > 0 and emg == 0:
            no_emergency.append((r["company_name"], active))
        if active > 0 and lic == 0:
            no_licence.append((r["company_name"], active))
    conn.commit()

    print(f"client_data_coverage rows written: {written}")

    cur.execute(
        "select sum(active_employees), sum(active_with_payment_method), "
        "sum(active_with_emergency_contact), sum(active_with_licence) "
        "from client_data_coverage")
    a, p, e, l = cur.fetchone()
    if a:
        print(f"across all tracked DSPs: {a} active employees, "
              f"{p} with a payment method ({100.0*p/a:.0f}%), "
              f"{e} with an emergency contact ({100.0*e/a:.0f}%), "
              f"{l} with a driving licence ({100.0*l/a:.0f}%)")

    for label, gaps in (("payment methods", no_payment),
                        ("emergency contacts", no_emergency),
                        ("driving licences", no_licence)):
        if gaps:
            print(f"\nZERO {label} despite active staff ({len(gaps)}):")
            for name, n in sorted(gaps, key=lambda x: -x[1]):
                print(f"   {str(name)[:44]:44s} {n:5d} active")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
