# -*- coding: utf-8 -*-
import csv, os, glob, re

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(PROJECT, "data")
DIR = r"C:\Users\shobhit.sharma\Downloads\PHIX-72859-onboarding-apis"
csv.field_size_limit(10_000_000)

FEIN_NAME = {
"992773412":"55th & 3rd LLC","815416452":"61 Degrees North LLC","844435229":"A A Huddle LLC",
"850801688":"Accelerated Logistics Corp","872277669":"Always More Logistics",
"851310274":"Amazing Home Delivery LLC","852876814":"Amazing Logistics Inc",
"853642271":"Beck Logistics LLC","874680378":"Blackwater Management LLC",
"872637160":"Caravan 12th Corporation","834642224":"Cat 5 Couriers","851098030":"CDC Logistics",
"852661720":"Chief Delivery LLC","921913091":"DNI Carriers LLC","932949097":"Door Desk Deliveries LLC",
"872098931":"East West Logistix","842381588":"Elite On Point Delivery Service Inc",
"994470285":"Excell Logistics Corp.","844797201":"Falcon Express Logistics",
"853291632":"Fass Logistics LLC","415303937":"First Line Logistics","920241570":"Flash Hub Delivery",
"842211186":"Fonguh Delivery Services LLC","851100497":"Goro Logistical LLC",
"842170332":"Hansen Brothers Delivery LLC","871780449":"Happy Delivery LLC",
"871375963":"High Distinction Logistics LLC","873718310":"InnovDel",
"393271662":"J4 Transit & Logistics, LLC","934155347":"JDW Logistics","920277902":"JM Parcel Service LLC",
"843994542":"KDL LLC","842880458":"Key Remnant Delivery Inc","993347180":"Lazo Logistics LLC",
"992400165":"Leadership Logistics LLC","993287799":"Lincoln Log LLC","993176161":"Majestic Logistix LLC",
"812040886":"MARK Logistics LLC","852549586":"MF Logistics LLC","834191394":"Mike And Fade Consult LLC",
"851764448":"Northstar Logistics LLC","333760897":"North Star Parcel LLC",
"851633535":"Outside The Box Logistics LLC","871956135":"Pria Logistics",
"850986274":"Prolific Logistics TX LLC","933092758":"Remson Deliveries LLC",
"873534994":"Secure Transit & Logistics, LLC",
"414824353":"Skyland Delivery Solutions LLC",
"874114615":"Sparkle Logistics LLC","920720113":"Spelman Logistics Inc","831384622":"Stave Delivery LLC",
"831967561":"Team Primos LLC","275227237":"Travel Management Professionals LLC","842278245":"TRUDELO LLC",
"333274309":"Urban Box Logistics LLC","884109370":"Valuable Logistics Inc","811064737":"Wheels for Work LLC",
}

MODULES = [
    ("EmployeeCensus", "Census"),
    ("PriorPayroll", "Prior Payroll"),
    ("PaymentMethodSetup", "Payment Method"),
    ("FedTaxWithholding", "Federal Tax Withholding"),
    ("StateTaxWithholding", "State Tax Withholding"),
    ("EmployeeDeductions", "Deductions"),
    ("WorkerCompensation", "Worker's Comp"),
    ("EmployeeContributions", "Contributions"),
    ("SocCode", "SOC Code"),
    ("CompanyJobTitle", "Company Job Title"),
    ("W2DeliveryMethod", "W2 Delivery Method"),
]

# --- gather vendor per fein from raw CSVs (most common vendor value wins) ---
vendor_counts = {}
rows_all = []
for path in glob.glob(os.path.join(DIR, "*.csv")):
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows_all.append(r)
            fein = r.get("fein")
            v = (r.get("vendor") or "").strip().upper()
            if fein and v:
                vendor_counts.setdefault(fein, {}).setdefault(v, 0)
                vendor_counts[fein][v] += 1

fein_vendor = {}
for fein, counts in vendor_counts.items():
    fein_vendor[fein] = max(counts.items(), key=lambda kv: kv[1])[0]  # ADP or PAYCOM

# --- load matrix_raw.tsv (already generated) ---
data = {}
with open(os.path.join(BASE, "matrix_raw.tsv"), encoding="utf-8") as f:
    reader = csv.DictReader(f, delimiter="\t")
    for row in reader:
        data.setdefault(row["fein"], {})[row["section"]] = (row["last"], row["by"])

def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')

clients = sorted(FEIN_NAME.items(), key=lambda kv: kv[1])  # (fein, name)

def short_date(d):
    parts = d.split("-")
    return f"{parts[1]}/{parts[2]}"

def short_by(by):
    name = by.split(".")[0]
    return name.capitalize()

# vendor for each client
client_vendor = {fein: ("ADP" if fein_vendor.get(fein, "ADP") == "ADP" else "Paycom") for fein, name in clients}

lines = []

# filter bar
lines.append('    <div class="matrix-filters">')
lines.append('      <div class="uzio-search matrix-search">')
lines.append('        <span class="uzio-search__icon" aria-hidden="true">&#8981;</span>')
lines.append('        <input class="uzio-search__input" id="clientSearch" placeholder="Search client name...">')
lines.append('      </div>')
lines.append('      <div class="matrix-chip-group" id="vendorFilter">')
lines.append('        <button class="uzio-filter-chip uzio-filter-chip--all" data-vendor="all">All vendors</button>')
lines.append('        <button class="uzio-filter-chip" data-vendor="ADP"><span class="uzio-filter-chip__dot" style="background:var(--uzio-color-action)"></span> ADP</button>')
lines.append('        <button class="uzio-filter-chip" data-vendor="Paycom"><span class="uzio-filter-chip__dot" style="background:var(--uzio-color-orange)"></span> Paycom</button>')
lines.append('      </div>')
lines.append('      <label class="matrix-toggle"><input type="checkbox" id="gapsOnly"> Only clients with a gap</label>')
lines.append('      <span class="matrix-count" id="matrixCount"></span>')
lines.append('    </div>')

lines.append('    <div class="uzio-table--wrap matrix-wrap">')
lines.append('      <table class="uzio-table matrix-table" id="matrixTable">')
th = ['        <thead><tr><th class="sticky-col">Module</th>']
for fein, name in clients:
    th.append(f'<th data-client="{slug(name)}" data-vendor="{client_vendor[fein]}" data-name="{name.lower()}">{name}<div class="mcell-sub">{client_vendor[fein]}</div></th>')
th.append('</tr></thead>')
lines.append("".join(th))
lines.append('        <tbody>')
for sec_key, sec_label in MODULES:
    cells = [f'          <tr><td class="sticky-col">{sec_label}</td>']
    for fein, name in clients:
        cell = data.get(fein, {}).get(sec_key)
        cslug = slug(name)
        if cell:
            last, by = cell
            cells.append(f'<td class="mcell" data-client="{cslug}" data-hit="1"><span class="uzio-status uzio-status--success">&#10003;</span><div class="mcell-sub">{short_date(last)} &middot; {short_by(by)}</div></td>')
        else:
            cells.append(f'<td class="mcell" data-client="{cslug}" data-hit="0"><span class="uzio-status uzio-status--error">&#10007;</span></td>')
    cells.append('</tr>')
    lines.append("".join(cells))
lines.append('        </tbody>')
lines.append('      </table>')
lines.append('    </div>')

html = "\n".join(lines)
out_path = os.path.join(BASE, "matrix_table.html")
with open(out_path, "w", encoding="utf-8") as f:
    f.write(html)

print("Clients:", len(clients))
print("Wrote", out_path, "-", len(html), "chars")
print("Vendor breakdown:", {v: list(client_vendor.values()).count(v) for v in set(client_vendor.values())})
