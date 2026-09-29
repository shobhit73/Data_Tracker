# Phase 2 — the dashboard's data views inside the CRM

**Status: SHIPPED 29 Sep 2026.** SQL run in the CRM's SQL editor (Shobhit),
589 rows pushed and verified, UI deployed via CRM commit `92be45e` (Shobhit's
github account has collaborator access), Data nav item live on
crm-teal-chi-45.vercel.app, old dashboard views frozen with banners.
`push_data_views.py` remains the refresh bridge — run it whenever the source
tables are refreshed.

## What ships

| Piece | File | Goes where |
|---|---|---|
| Tables + RLS | `2026-09-29-phase2-data-views.sql` | CRM Supabase **SQL editor**, run once (then keep a copy in the CRM repo's `scripts/migrations/`) |
| Data bridge | `push_data_views.py` | stays HERE — reads our Supabase, replaces the CRM copies; re-run after any source refresh |
| UI | `crm-site/views-data.js` (new) + `crm-site/{app,store,index}.html/js` (modified copies, based on CRM commit `07c581c`) | CRM repo `site/`, then push → Vercel |

One new nav item **Data** (admin + implementor), four tabs:

- **API Activity** — clients × the nine onboarding APIs, ✓/!/✕ per module with
  last-OK date; vendor filter and a gaps-only toggle.
- **Payroll Health** — prior-payroll window vs Uzio runs, gap days highlighted,
  status filter.
- **Data Coverage** — % of active employees with payment method / emergency
  contact / licence / worker comp, as bars.
- **Documents** — the transfer-mail record and what prod actually holds
  (docs ratio runs against ALL employees — documents cover leavers too).

## Rollout order

1. **Shobhit** — CRM Supabase → SQL editor → paste and run
   `2026-09-29-phase2-data-views.sql`. Idempotent.
2. **Shobhit/Claude** — `py crm-merge/push_data_views.py --dry-run`, then
   without the flag. Expect ~589 rows across five tables.
3. **Rohit (or with repo access)** — copy the four `crm-site/` files into the
   CRM repo's `site/` (three are whole-file replacements, `views-data.js` is
   new), commit, push. Vercel deploys; the Data nav item appears on next load.
4. After the CRM shows the data: freeze the four views on the old dashboard
   with the same "moved to CRM" banner Open Items got.

## Standing notes

- These five tables are **read-only reporting copies**. The sources stay on
  our side (prod queries, PHIX-72859 CSVs, transfer mails); `push_data_views.py`
  is a full replace, so nothing in the CRM copies is ever hand-edited.
- The modified site files are based on CRM commit `07c581c` (27 Aug 2026). If
  Rohit has pushed since, re-apply the (small) diffs instead of overwriting:
  one NAV entry + one route in `app.js`, five Store functions + exports in
  `store.js`, one script tag in `index.html`.
- `preview/` is a login-free local harness for `views-data.js` — real styles,
  Store stubbed from `fixture.js` (regenerate: see git history of this folder).
  It never deploys anywhere.
