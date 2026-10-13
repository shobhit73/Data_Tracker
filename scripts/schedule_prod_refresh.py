"""Put prod-refresh on a daily schedule inside our Supabase (pg_cron + pg_net).

Mirrors the CRM's "Refresh everything" button as three cron jobs, at
16:35 / 16:45 / 16:52 IST (11:05 / 11:15 / 11:22 UTC) - all done before the
17:30 IST Apps Script run pushes the data views to the CRM, so the CRM's
morning-US view carries today's prod numbers with nobody pressing anything.

The function authenticates the caller: cron presents CRON_SECRET (stored at
memory/_secrets/prod-refresh-cron.env, already set on the function), and the
run shows up as ranBy "cron@daily-schedule". The secret necessarily lives in
cron.job's command column - readable only by the database's postgres role,
which already holds every other key to this castle.

Idempotent: cron.schedule() by name replaces the existing entry. Unschedule:
  select cron.unschedule('prod-refresh-daily-1');  -- likewise -2, -3
"""
import os

from supabase_helper import connect

STORE = os.path.join(os.path.expanduser("~"), ".claude", "projects",
    "C--Users-shobhit-sharma-Downloads-Uzio-Code", "memory", "_secrets",
    "prod-refresh-cron.env")
URL = "https://nqiyiherkzlhorsnyeni.supabase.co/functions/v1/prod-refresh"

BATCHES = [
    ("prod-refresh-daily-1", "5 11 * * *",
     '{"jobs":["backfill_fein","work_locations","data_coverage",'
     '"document_counts","system_activity","payroll_health","api_activity"]}'),
    ("prod-refresh-daily-2", "15 11 * * *", '{"jobs":["load_history"]}'),
    ("prod-refresh-daily-3", "22 11 * * *", '{"jobs":["push_to_crm"]}'),
    # 17:55 IST - after Apps Script's 17:30 run has refreshed the CRM's
    # hist_clients, so the Historical rule judges today's scan, not yesterday's.
    ("prod-refresh-daily-4", "25 12 * * *", '{"jobs":["task_evidence"]}'),
]


def main():
    secret = [l.split("=", 1)[1].strip() for l in open(STORE)
              if l.startswith("CRON_SECRET=")][0]
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("create extension if not exists pg_cron")
    cur.execute("create extension if not exists pg_net")
    print("extensions: pg_cron, pg_net ok")

    for name, when, jobs in BATCHES:
        cmd = cur.mogrify(
            "select net.http_post(url := %s, "
            "headers := jsonb_build_object('Authorization', %s, "
            "'Content-Type', 'application/json'), "
            "body := %s::jsonb, timeout_milliseconds := 150000)",
            (URL, "Bearer " + secret, jobs)).decode()
        cur.execute("select cron.schedule(%s, %s, %s)", (name, when, cmd))
        print("scheduled %-22s %s" % (name, when))

    cur.execute("select jobname, schedule, active from cron.job "
                "where jobname like 'prod-refresh%%' order by jobname")
    for r in cur.fetchall():
        print("  cron.job: %-22s %-12s active=%s" % r)


if __name__ == "__main__":
    main()
