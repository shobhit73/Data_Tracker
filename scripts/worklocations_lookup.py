"""Full work-location detail (name + address) for a list of FEINs, via prod-query.

Usage:
    python worklocations_lookup.py                       # uses the 4 pilot clients below
    python worklocations_lookup.py 992400165,993347180    # or pass a comma-separated FEIN list
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pq_helper import run

FEINS = ['920720113', '993347180', '333760897', '920241570']  # Spelman, Lazo, North Star, Flash Hub

if __name__ == "__main__":
    feins = sys.argv[1].split(",") if len(sys.argv) > 1 else FEINS
    inlist = ",".join("'" + f + "'" for f in feins)
    sql = ("select eo.company_name, wl.work_location_name, wl.address_line1, wl.address_line2, "
           "wl.city, wl.state, wl.zip_code, wl.primary_location, wl.location_identifier "
           "from employer_organization eo "
           "join emp_work_location wl on wl.employer_organization_id = eo.id "
           "where replace(coalesce(eo.fein,''),'-','') in (" + inlist + ") and eo.deleted=0 and wl.deleted=0 "
           "order by eo.company_name, wl.primary_location desc, wl.work_location_name")
    run(sql, size=100)
