# DSP Ops Dashboard

Internal reporting dashboard tracking Amazon DSP client onboarding — implementation status, historical
data collection, audit coverage, and onboarding API activity. Built as a single-file HTML artifact
styled with the UZIO Design System, structured as a left-nav app with 5 views.

**Live dashboard:** https://claude.ai/code/artifact/4feef555-d650-42df-a98a-82838a5d22ce
(private — owned by the session that published it; republish from `dashboard/dsp_dashboard.html`
passing this URL to update it in place rather than minting a new link)

**Snapshot date:** 08/12/2026. Everything in the dashboard is a point-in-time pull — nothing here is
live/auto-refreshing. Re-run the relevant script (or re-do the manual Drive/email check) and republish
to update.

---

## Folder layout

```
dsp-ops-dashboard/
├── CLAUDE.md                    ← this file
├── dashboard/
│   └── dsp_dashboard.html       ← the actual deliverable (canonical copy — edit this, then republish)
├── scripts/
│   ├── pq_helper.py             ← shared prod-query connector (JWT mint/cache + run(sql))
│   ├── fein_lookup.py           ← FEIN list → company_name / company_identifier / live_status
│   ├── worklocations_lookup.py  ← FEIN list → work location name + full address
│   ├── analyze_api_runs.py      ← per-client/per-module run stats + categorized errors (4 pilot clients)
│   └── gen_matrix.py            ← generates the API Activity tick/cross matrix HTML (all 57 clients)
│   └── make_icon_datauris.py    ← converts Ruprekha SVG icons to inline CSS data-URIs
└── data/
    ├── matrix_raw.tsv           ← cache: (fein, module) → (last_run_date, run_by), feeds gen_matrix.py
    └── matrix_table.html        ← output of gen_matrix.py — the `<table>` fragment spliced into the dashboard
```

The raw source data is **not** duplicated into this project — see below.

---

## The 5 views and their scope (scope differs per view — this is intentional, not an oversight)

| View | Scope | Source |
|---|---|---|
| **Client Overview** | 4 pilot clients (Spelman, Lazo, North Star, Flash Hub) | prod (`employer_organization`, `emp_work_location`) + Shruti's Implementation Onboarding Tracker |
| **Historical Data** | 14 clients (Rohit's audit roster) | Historical Data reference doc + each client's Drive "Historical Data" subfolder |
| **Audit Coverage** | same 14 clients | Rohit Kaushik's daily "Audit coverage" email + each client's Drive "Audit Files" subfolder |
| **API Activity** | all 57 tracked clients (test/sandbox excluded) | PHIX-72859 onboarding API run log CSVs |
| **Open Items** | hand-curated | findings surfaced while building the other 4 views |

---

## Data sources (external to this project — not copied in)

- **Raw onboarding API run logs** — `~/Downloads/PHIX-72859-onboarding-apis/*.csv` (11 files, ~88MB, a
  manual export tied to Jira ticket PHIX-72859). `analyze_api_runs.py` and `gen_matrix.py` both read
  directly from that path. If the folder is gone, ask the team for a fresh export from the ticket's
  audit table — don't assume "no runs" just because the file is missing.
- **prod DB** via the `prod-query` Claude skill (read-only, NeuronOps `/query` endpoint,
  `.claude/skills/prod-query/` in the main Uzio Code workspace). `scripts/pq_helper.py` is the shared
  connector — it mints/caches its own JWT under
  `~/.claude/projects/<sanitized-workspace-path>/memory/_secrets/` (gitignored, never commit).
- **Amazon DSP Drive folder** —
  `https://drive.google.com/drive/folders/1GiUQzY37s4KMOZ6TF7emzVSfUyE4sk9c` — one subfolder per
  client. Checked manually via the Drive connector, not scripted — folder taxonomy is inconsistent
  across clients/eras (see Known caveats), so a reliable script would need per-era heuristics.
- **Shruti's "Uzio Implementation Onboarding Tracker"** —
  `https://docs.google.com/spreadsheets/d/1GRnfKMp4tcjGXWhkx5rpRKQD8eadikZPNqeufctoXsI` (tab: "DSP
  Implementation"). ~80 columns; the dashboard only pulls a handful (live dates, RAG, payroll dates).
- **Rohit's daily "Audit coverage" email** — subject pattern `Audit coverage — N of 14 clients need
  action — MM/DD/YYYY`, sent to `implementation@uzio.com`. Read via the Gmail connector.
- **Historical Data reference doc** —
  `https://docs.google.com/document/d/1Lp3By25bIlOMwAVAt_LFiWGjgDZPKrCQ` — the checklist of required
  reports per vendor (ADP section is short; Paycom section is ~44 items and hasn't been audited
  line-by-line for any client yet).

---

## Scripts

All scripts are plain Python (stdlib only — `urllib`, `json`, `csv`, no pip installs needed).

- **`pq_helper.py`** — `run(sql, size=200)` sends one read-only SELECT to prod via NeuronOps. Import it
  from another script in the same folder (`sys.path.insert(0, os.path.dirname(...))`, see the other
  scripts for the pattern).
- **`fein_lookup.py`** — resolves a FEIN list to employer records. Run bare for all 57 tracked FEINs, or
  `python fein_lookup.py <fein1>,<fein2>` for a subset.
- **`worklocations_lookup.py`** — full work-location name + address per FEIN. Same CLI-arg pattern.
- **`analyze_api_runs.py`** — per-client, per-module: run count, first/last date, total
  attempted/succeeded/failed (from the API response's own `TotalMap`/`SuccessMap`/`FailureMap`, not
  guessed), plus every distinct error message normalized into a human category. **Hardcoded to the 4
  pilot clients** (`FEIN_TO_CLIENT` at the top) — edit that dict to cover others.
- **`gen_matrix.py`** — generates the full API Activity table (11 modules × 57 clients, tick/cross +
  last-run date/by + vendor tag, with `data-client`/`data-vendor`/`data-name` attributes for the
  dashboard's client-search/vendor-filter/gaps-only JS). Reads `data/matrix_raw.tsv`. Writes
  `data/matrix_table.html` — splice that `<table>` block into `dashboard/dsp_dashboard.html`'s API
  Activity section (replace everything from `<div class="uzio-table--wrap matrix-wrap">` through its
  matching `</div>`) after regenerating.
- **`make_icon_datauris.py`** — reads SVGs from `.claude/skills/ruprekha/icons/`, prints CSS
  `--uzio-icon-*: url("data:image/svg+xml,...")` declarations. Used once to build the dashboard's inline
  icon set; re-run and paste into the `<style>` block's `:root` if a new Ruprekha icon is needed.

### Regenerating `matrix_raw.tsv`

Not yet a standalone script — it was built inline during the session: scan every CSV in the
PHIX-72859 folder, and for each row parse `error_messages`/`optional_validations` (both are JSON) and
take their **top-level keys** as "which module this run touched" (present whether the run errored or
not). Keep the latest `created_date`/`created_by` per `(fein, module)`. See `analyze_api_runs.py`'s
section-detection loop for the exact JSON-key logic if this needs to become a real script — it's the
same parsing, just aggregated differently (this file wants *latest only*, `analyze_api_runs.py` wants
*full history*).

---

## Known caveats baked into the dashboard (don't silently "fix" these without re-checking)

- **8 clients excluded from the 57** as test/sandbox accounts, identified **by name** (some still carry
  a DSP-format `company_identifier`, so identifier alone isn't a safe filter): AA prod, AA prod 01,
  A Mobile Company 1, DSP 101, DSP 102, DSP Test, DSP Trial, Vatica Health Sandbox.
- **API Activity counts are cumulative across every attempt**, not deduplicated by employee — a module
  re-run after a fix counts both the earlier failure and the later success. Reads as "how much friction
  did this module take," not "how many employees are still stuck."
- **InnovDel's Census audit** shows as missing in Rohit's mail, but a Census audit file dated 08/07
  exists in the Drive folder under a generic `Client_Uzio_ADP_Census…` name instead of the expected
  `InnovDel_…` prefix — most likely a naming-pattern miss in whatever scans for audit files, not an
  actual gap. Flagged, not silently corrected.
- **2026 (current year) Payroll History** for ADP clients lives in each client's onboarding-side
  "Payroll Setup" Drive folder as quarterly cuts, not in "Historical Data" as an annual file — same
  data, different location. Don't read a blank in Historical Data as "missing" without checking Payroll
  Setup too.
- **Historical Data / Audit Coverage (views 2–3) are hand-researched, not script-generated** —
  refreshing them means re-browsing each client's Drive folder and re-reading Rohit's latest email, not
  re-running a script.
- **First Line and InnovDel** both show complete-or-near-complete Audit Coverage while their Historical
  Data collection is barely started — the two tracks run independently; a client "done" on one can be
  untouched on the other.

---

## Design system — Ruprekha / UZIO DS

Built with the `ruprekha` Claude skill (`.claude/skills/ruprekha/` in the main Uzio Code workspace) —
Nunito typography, warm cream background, 240px left nav, cyan = action / orange = "you are here".

This dashboard is a **standalone internal tool**, not a literal UZIO product screen — it borrows the
visual language and reuses the DS's "expanded sidebar" component (`.uzio-sidebar-x`) as its own primary
nav, populated with this app's 5 views instead of UZIO's global product nav (Dashboard/Employees/
Payroll/etc). That's a deliberate adaptation, not a DS violation.

**Artifact CSP note:** the published dashboard is a single self-contained HTML file — Claude's Artifact
sandbox blocks all external requests (fonts, icon files, everything). Two consequences baked in:
- Nunito is **not** loaded from Google Fonts (`<link>` would be blocked) — the font stack falls back to
  `'Nunito', 'Segoe UI', Helvetica, Arial, sans-serif`, so real Nunito glyphs only render if the
  viewer's OS happens to have the font installed.
- All UZIO icons are inlined as CSS `data:image/svg+xml` URIs (see `make_icon_datauris.py`) rather than
  referenced as `icons/*.svg` files, since Artifacts can't ship a sibling assets folder.

If a **non-Artifact** deployment of this dashboard is ever wanted (e.g. handed to engineers as a real
`assets/{css,icons}/` project per Ruprekha's normal output format), regenerate from
`dashboard/dsp_dashboard.html` by extracting the inline `<style>` into `assets/css/`, restoring the
Google Fonts `<link>`, and swapping the icon data-URIs back to `url(assets/icons/<name>.svg)` — the
class names already match the DS 1:1.

---

## How to update the dashboard

1. Edit `dashboard/dsp_dashboard.html` directly for structural/content changes, or regenerate a data
   block via the relevant script in `scripts/` and splice its output in.
2. Republish via Claude's Artifact tool, passing this file's path. From a **new** Claude Code session
   that doesn't already own the artifact, pass the live URL above as `url` so it updates in place
   instead of minting a second link.
3. Sanity-check structure before publishing on anything but a small edit — grep for balanced
   `<section id="view-*">` / `</section>` pairs and confirm the nav `data-view` values still match the
   section `id`s (`view-overview`, `view-historical`, `view-audit`, `view-api`, `view-open`).
