# Unified Platform — Phase 1: Open Items → CRM

**Date:** 2026-09-28 · **Status:** EXECUTED 2026-09-28 — 10 items imported as CRM
tasks #1571–1580 (Shobhit had direct Supabase access, so the hand-off steps
collapsed); 2 Flash Hub items (both Done) archived in the backup JSON instead,
since that client is absent from the CRM and creating it would auto-generate 17
open template tasks. Remaining: `scripts/lock_open_items.py` to be run by hand
(permission-gated), and Rohit told about the 4 new open tasks in his view.
**Repos:** this one (source) + https://github.com/Rohit-Kaushik-git/CRM (destination)

## Goal

Retire the dashboard's anonymously-writable `open_items` table. Hand-tracked action
items move into the CRM as ad-hoc tasks, gaining what they never had here: login,
roles, append-only notes with real authorship, and an activity timeline. This also
closes the dashboard's one open write surface — the anon key shipped in the public
page currently holds INSERT/UPDATE on `open_items`.

## Verified facts this plan is built on

**Source — `open_items` (our Supabase), 12 rows: 4 Open, 8 Done.**
Columns: `id, severity, title, description, status, date_added, due_date,
pending_for, assignee, completed_by, completed_at`.
- Every title is prefixed with a client name ("Stave - …", "First Line - …",
  "InnovDel - …", "Flash Hub - …", "High Distinction - …") — client mapping is
  derivable from the title.
- `assignee` holds **external client contacts** (Mercedes Hallback, Tierra
  Williams), not Uzio users. It means "pending on this person", not "worked by".

**Destination — CRM `tasks` (Rohit's Supabase).**
- `client_id` is **NOT NULL** — every task must attach to a CRM client.
- Ad-hoc task = `template_id IS NULL`. `unique(client_id, template_id)` does not
  dedupe ad-hoc tasks, so idempotency must be enforced by the import itself.
- Task INSERT is admin-only under RLS; a service-key import bypasses RLS and is
  the intended path (same as their sheet-sync).
- `task_notes` is append-only; `activity_log` fills itself via DB triggers.
  Service-role writes have `auth.uid() = null` → shown as "sync", and do **not**
  set `app_touched`, so their sheet-sync conflict rule is unaffected.
- Ownership: a task with no `assignee_id`/`assigned_team` defaults to the
  client's implementor (`can_work_task`).

## Field mapping

| open_items | CRM | Note |
|---|---|---|
| title (client prefix stripped) | `tasks.title` | client resolved from the prefix |
| title's client prefix | `tasks.client_id` | via explicit name→client map in the script (12 rows; a hardcoded dict is fine and auditable) |
| status Open / Done | status Open / Done | — |
| due_date | due_date | — |
| completed_at | done_date | date part |
| description + severity + pending_for + assignee (external contact) + completed_by + date_added | **first `task_note`**, verbatim | nothing is lost; the note opens the append-only history with full provenance |
| pending_for containing "Data Team" | `assigned_team` = 'Data Team' | the live data made this mapping obvious: 8 rows say "Data Team (Rohit & Shobhit)", 4 say "Implementation" (→ null, implementor default) |
| assignee | — (`assignee_id` stays null) | external contacts are not CRM users; ownership falls to the client's implementor by design |
| — | `template_id` = null | marks it ad-hoc |
| — | `created_by` = null | service-key import; timeline shows "sync", real provenance lives in the note |

All 8 Done rows migrate too — they are history, and history is the point of the
notes model. Cost is 8 rows.

## Steps

1. **Write the import script** — ✅ done 2026-09-28: `crm-merge/import_open_items.py`
   in this repo, ready to drop unchanged into the CRM repo's `scripts/`.
   Stdlib-only Python, service key from `.env`, matching their house style
   (`sync_sheets.py`). Extra `--offline` mode previews the mapping with no CRM
   access at all (already run clean against the 2026-09-28 backup: 12/12 mapped).
   - `--dry-run` prints the full row-by-row mapping (source row → client, title,
     status, note text) and writes nothing.
   - Client resolution: title prefix → CRM `clients` by `dsp_name`/`short_code`
     via the script's mapping dict. Any unmatched client **aborts the run** with a
     report — fix the map, rerun. Never guess, never auto-create a client.
   - Idempotent: skip any client that already has an ad-hoc task with the same
     title (re-runs add nothing).
2. **Back up the source** — dump all 12 `open_items` rows to
   `data/open_items_backup_<date>.json` (existing convention in this repo).
3. **Dry-run review with Rohit** — he owns the CRM and its Open Items view; 4 new
   open ad-hoc tasks will appear there, grouped under each client's implementor.
   He confirms the client matches and that implementor-default ownership is what
   he wants (alternative: set `assigned_team` per task).
4. **Live run** with the CRM service key (Rohit runs it, or shares the key for
   one run — his call; the key never enters this repo or any chat).
5. **Verify in the CRM UI** — each migrated task on the right client, provenance
   note attached, Done items closed with `done_date`, admin Open Items showing
   exactly the 4 open ones.
6. **Lock the source table** — revoke anon INSERT/UPDATE on `open_items`
   (keep SELECT so the old view still renders); replace the dashboard's Open
   Items form with a read-only banner linking to the CRM. Republish site +
   artifact. This restores the "anon key is select-only" posture everywhere.
7. **Update docs** — this repo's CLAUDE.md ("Open Items is writable" section
   becomes "moved to CRM <date>"); one line in the CRM CLAUDE.md runbook about
   the import script.

## Prerequisites (Rohit)

- Confirm the five clients exist in CRM `clients`: Stave Delivery, First Line
  Logistics, InnovDel, Flash Hub Delivery, High Distinction. (CRM syncs from
  Shruti's tracker, so they should — the dry run proves it.)
- Service key access for the one-time run (or he runs it).
- Sign-off on step 3.

## Risks / open questions

- **CRM client list is unverifiable from here** (no credentials to Rohit's
  Supabase) — the dry run is the gate; nothing writes before it passes.
- **High Distinction** may not be in the CRM if it predates the sheet-sync window
  (CRM's original import filtered to TT live date after 2026-07-31). If missing:
  Rohit either adds the client or we agree that its two items stay archived in
  the backup JSON instead of migrating.
- **Duplicate tracking during transition** — between the live run and step 6 the
  item lists exist in two places. Do steps 4–6 in one sitting.

## Out of scope (later phases)

Phase 2: API Activity / Payroll Health / Data Coverage / Document Transfer as
read-only CRM views fed by this repo's scripts. Phase 3: Historical Data sheet as
a CRM sync source. Also not here: auth for the old dashboard (pointless — it is
being absorbed), custom domain, Jira.
