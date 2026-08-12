"""One-shot: (re)create the DSP Ops Dashboard tables in Supabase from schema.sql.

Drops client_overview/client_work_locations first since their shape changed
(dsp_short_code business key instead of fein) — safe while both are empty.
"""
import os

from supabase_helper import connect

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_PATH = os.path.join(HERE, "schema.sql")

DROP_FOR_RESHAPE = """
drop table if exists client_work_locations;
drop table if exists client_overview;
"""

if __name__ == "__main__":
    with open(SQL_PATH, encoding="utf-8") as f:
        sql = f.read()

    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(DROP_FOR_RESHAPE)
    cur.execute(sql)

    cur.execute(
        """
        select table_name from information_schema.tables
        where table_schema = 'public' order by table_name
        """
    )
    print("Tables in public schema now:")
    for (t,) in cur.fetchall():
        print(" -", t)

    cur.close()
    conn.close()
