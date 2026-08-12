# DSP Ops Dashboard

An internal dashboard tracking Amazon DSP client onboarding for the UZIO implementation team —
client status, historical-data collection, audit coverage, and onboarding API activity, all in one
place instead of scattered across Drive, Gmail, and spreadsheets.

**Live dashboard:** https://claude.ai/code/artifact/4feef555-d650-42df-a98a-82838a5d22ce

Snapshot as of **08/12/2026**. Nothing here is live — it's a point-in-time pull, refreshed manually.

---

## What's inside

| View | What it shows | Clients covered |
|---|---|---|
| **Client Overview** | Vendor, FEIN, live dates, work locations w/ address | 4 pilot clients |
| **Historical Data** | ADP/Paycom required-report checklist compliance | 14 clients |
| **Audit Coverage** | Census/Withholding/Payment/etc. audit file status | 14 clients |
| **API Activity** | Which onboarding module ran, when, and who ran it — searchable, filterable by vendor, with a "gaps only" toggle | all 57 tracked clients |
| **Open Items** | Everything worth following up on, found while building the above | — |

## Folder layout

```
dashboard/   the actual HTML file — this is what's published
scripts/     Python tools that pull/refresh the underlying data
data/        cached intermediate data the scripts read and write
```

## Quick start

- **Just want to look at it?** Open the live link above — nothing to run.
- **Want to edit it?** Open `dashboard/dsp_dashboard.html` directly, or regenerate a data section with
  a script in `scripts/` and splice its output in.
- **Want to refresh the numbers?** See `CLAUDE.md` — it has the full data-source list, what each
  script needs, and the gotchas we hit building this (test-account exclusions, a couple of
  naming-mismatch false positives, etc.) so you don't have to rediscover them.

## Requirements to run the scripts

Plain Python 3, standard library only — no `pip install` needed. `scripts/pq_helper.py` talks to prod
through the `prod-query` Claude skill, so it needs that skill's cached credentials/JWT to already exist
(they're stored outside this folder, under your Claude memory directory).

---

For everything else — exact data sources, per-script usage, and the list of known caveats baked into
the current numbers — see **[CLAUDE.md](CLAUDE.md)**.
