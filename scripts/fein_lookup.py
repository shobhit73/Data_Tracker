"""Resolve a list of FEINs to Uzio employer records (name, DSP code, live status) via prod-query.

Usage:
    python fein_lookup.py                       # uses the FEINS list below (all 57 tracked clients)
    python fein_lookup.py 992400165,993347180    # or pass a comma-separated FEIN list on the CLI
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pq_helper import run

FEINS = "232332223,232432324,275227237,333274309,333760897,393271662,414824353,415303937,565656565,769465445,811064737,812040886,815416452,831384622,831967561,834191394,834642224,842170332,842211186,842278245,842381588,842880458,843994542,844435229,844797201,850801688,850986274,851098030,851100497,851310274,851633535,851764448,852549586,852661720,852876814,853291632,853642271,871375963,871780449,871956135,872098931,872277669,872637160,873534994,873718310,874114615,874680378,876876982,884109370,920241570,920277902,920720113,921913091,927387483,932949097,933092758,934155347,990000001,991182990,992400165,992773412,993176161,993287799,993347180,994470285".split(",")

if __name__ == "__main__":
    feins = sys.argv[1].split(",") if len(sys.argv) > 1 else FEINS
    inlist = ",".join("'" + f + "'" for f in feins)
    sql = ("select company_name, company_identifier, replace(coalesce(fein,''),'-','') as fein_norm, live_status "
           "from employer_organization where replace(coalesce(fein,''),'-','') in (" + inlist + ") "
           "and deleted=0 order by company_name")
    run(sql, size=100)
