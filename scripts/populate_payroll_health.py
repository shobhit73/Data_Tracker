"""Payroll Health Check: does every TY2026 pay period that ran have payroll
behind it in Uzio, and where does the handover from the old vendor sit.

WHY INTERVALS, NOT COUNTS
    Prior payroll is not loaded one row per pay period. Lazo's whole pre-go-live
    year arrives as four consolidated rows, one of which spans 2025-12-14 to
    2026-03-21. Counting payroll rows against the weekly calendar therefore
    invents gaps: the first version of this check reported 23 missing periods
    for a client that is fully covered. Coverage is the union of the date ranges
    the payroll rows span, and a gap is a stretch of days none of them touch.

WHERE THE PIECES COME FROM
    payroll_dates          -> the calendar: which periods actually ran
    ups_employer_paycheck_detail
      paycheck_type=PRIOR  -> the old vendor's payroll, loaded into Uzio
      paycheck_type=NORMAL -> Uzio's own payrolls after go-live
    The handover is where PRIOR ends and NORMAL begins. A gap there means a
    week that neither system owns, which is invisible when you look at either
    side on its own -- it is how North Star and Spelman each lost a week.

Run:  python populate_payroll_health.py
Writes only payroll_health. Never touches open_items or
historical_data_checklist (human-owned), nor api_activity_runs (manual).
"""
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pq_helper
from supabase_helper import connect

YEAR_START = date(2026, 1, 1)

DDL = """
create table if not exists payroll_health (
  dsp_short_code text primary key,
  fein text,
  company_name text,
  target_from date,
  target_to date,
  prior_from date,
  prior_to date,
  prior_rows integer,
  normal_from date,
  normal_to date,
  normal_rows integer,
  handover_gap boolean,
  gap_days integer,
  gap_ranges text,
  previous_system text,
  status text,
  checked_date date,
  updated_at timestamptz default now()
)
"""

UPSERT = """
insert into payroll_health
  (dsp_short_code, fein, company_name, target_from, target_to,
   prior_from, prior_to, prior_rows, normal_from, normal_to, normal_rows,
   handover_gap, gap_days, gap_ranges, previous_system, status, checked_date)
values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,current_date)
on conflict (dsp_short_code) do update set
  fein=excluded.fein, company_name=excluded.company_name,
  target_from=excluded.target_from, target_to=excluded.target_to,
  prior_from=excluded.prior_from, prior_to=excluded.prior_to,
  prior_rows=excluded.prior_rows,
  normal_from=excluded.normal_from, normal_to=excluded.normal_to,
  normal_rows=excluded.normal_rows,
  handover_gap=excluded.handover_gap, gap_days=excluded.gap_days,
  gap_ranges=excluded.gap_ranges, previous_system=excluded.previous_system,
  status=excluded.status,
  checked_date=excluded.checked_date, updated_at=now()
"""


def pq(sql, size=5000):
    jwt = pq_helper.get_jwt()
    status, body = pq_helper.post(
        pq_helper.GATEWAY + "/api/neuronops/query",
        {"sql": sql, "size": size},
        {"Authorization": "Bearer " + jwt, "X-Auth-Type": "bearer"},
    )
    if status != 200:
        print("prod-query failed:", status, str(body)[:400])
        sys.exit(1)
    if body.get("hasMore"):
        print("WARNING: truncated at", size, "rows")
    return body["data"]


def D(v):
    return date.fromisoformat(str(v)[:10])


def merge(ivs):
    """Merge overlapping or day-adjacent [start, end] ranges."""
    out = []
    for s, e in sorted(ivs):
        if out and s <= out[-1][1] + timedelta(days=1):
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def gaps(covered, lo, hi):
    res, cur = [], lo
    for s, e in covered:
        if e < lo or s > hi:
            continue
        if s > cur:
            res.append((cur, min(s - timedelta(days=1), hi)))
        cur = max(cur, e + timedelta(days=1))
        if cur > hi:
            break
    if cur <= hi:
        res.append((cur, hi))
    return res


def main():
    conn = connect()
    cur = conn.cursor()
    cur.execute(DDL)
    conn.commit()

    cur.execute("select dsp_short_code, fein, dsp_name, previous_system "
                "from client_overview where fein is not null")
    clients = {f: (c, n, ps) for c, f, n, ps in cur.fetchall()}
    inlist = ",".join("'" + f + "'" for f in clients)
    print(f"{len(clients)} DSPs with a fein")

    # last period whose payroll date has already passed -- the end of the window
    # we can fairly hold anyone to.
    cal = {r["fein"]: D(r["last_end"]) for r in pq(
        "select replace(coalesce(eo.fein,''),'-','') as fein, "
        "max(cast(pd.pay_period_end_date as date)) as last_end "
        "from employer_organization eo "
        "join employer_payroll_info epi on epi.employer_organization_id = eo.id "
        "join payroll_dates pd on pd.employer_payroll_info_id = epi.id and pd.deleted = 0 "
        "where eo.deleted = 0 and pd.payroll_date <= current_date "
        "and pd.pay_period_start_date >= '2025-01-01' "
        "and replace(coalesce(eo.fein,''),'-','') in (" + inlist + ") group by 1")}

    rows = pq(
        "select replace(coalesce(fein,''),'-','') as fein, paycheck_type, "
        "cast(payperiod_start_date as date) as s, cast(payperiod_end_date as date) as e "
        "from ups_employer_paycheck_detail "
        "where deleted = 0 and paycheck_type in ('PRIOR','NORMAL') "
        "and payperiod_end_date >= '2025-11-01' "
        "and payperiod_start_date <= current_date "
        "and replace(coalesce(fein,''),'-','') in (" + inlist + ")")
    print(f"{len(rows)} payroll rows from prod, {len(cal)} clients with a calendar")

    by = {}
    for r in rows:
        by.setdefault(r["fein"], {}).setdefault(r["paycheck_type"], []).append(
            (D(r["s"]), D(r["e"])))

    written = flagged = 0
    problems = []
    for fein, (code, name, prev) in clients.items():
        hi = cal.get(fein)
        d = by.get(fein, {})
        if not hi or not d:
            continue                      # nothing has run yet — nothing to judge
        pr = merge(d.get("PRIOR", []))
        no = merge(d.get("NORMAL", []))
        g = gaps(merge(d.get("PRIOR", []) + d.get("NORMAL", [])), YEAR_START, hi)
        gap_days = sum((e - s).days + 1 for s, e in g)
        # A handover gap is the specific case worth naming: the old vendor
        # stopped, Uzio started, and a week fell between them.
        handover = bool(pr and no and no[0][0] > pr[-1][1] + timedelta(days=1))
        # A client new to the platform has no previous system to load payroll
        # from, so an empty pre-go-live stretch is correct, not a gap. Without
        # this 12 of the 21 flagged clients were false alarms.
        is_new = (prev or "").strip().lower() == "new"
        if not g:
            status = "Covered"
        elif is_new:
            status = "New to platform"
        elif handover:
            status = "Handover gap"
        else:
            status = "Gap"
        cur.execute(UPSERT, (
            code, fein, name, YEAR_START, hi,
            pr[0][0] if pr else None, pr[-1][1] if pr else None,
            len(d.get("PRIOR", [])),
            no[0][0] if no else None, no[-1][1] if no else None,
            len(d.get("NORMAL", [])),
            handover, gap_days,
            "; ".join("%s..%s" % (s, e) for s, e in g) or None,
            prev, status))
        written += 1
        if g and not is_new:
            flagged += 1
            problems.append((gap_days, name, status,
                             "; ".join("%s..%s" % (s, e) for s, e in g)))
    conn.commit()

    print(f"payroll_health rows written: {written}, with gaps: {flagged}")
    if problems:
        print("\nclients with uncovered days in TY2026:")
        for days, name, status, rng in sorted(problems, reverse=True):
            print("   %-32s %-14s %4d days   %s" % (str(name)[:32], status, days, rng))

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
