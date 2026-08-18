"""Read-only inspection of the three tables that actually drive the dashboard's
Historical Data view: historical_report_catalog, historical_scope,
historical_report_status. Writes nothing.
"""
from supabase_helper import connect

TABLES = [
    "historical_report_catalog",
    "historical_scope",
    "historical_report_status",
]


def main():
    conn = connect()
    cur = conn.cursor()

    for table in TABLES:
        cur.execute(
            "select column_name, data_type from information_schema.columns "
            "where table_name = %s order by ordinal_position",
            (table,),
        )
        cols = cur.fetchall()
        cur.execute(f"select count(*) from {table}")
        count = cur.fetchone()[0]
        print("=" * 70)
        print(f"{table}  ({count} rows)")
        print("  columns:", [f"{c[0]}:{c[1]}" for c in cols])
        cur.execute(f"select * from {table} limit 6")
        for row in cur.fetchall():
            print("   ", row)

    print("=" * 70)
    print("Stave-specific:")
    for table in TABLES:
        cur.execute(
            "select column_name from information_schema.columns "
            "where table_name = %s and column_name ilike '%%client%%'",
            (table,),
        )
        client_cols = [r[0] for r in cur.fetchall()]
        if not client_cols:
            print(f"  {table}: no client column")
            continue
        col = client_cols[0]
        cur.execute(f"select count(*) from {table} where {col} ilike '%%stave%%'")
        print(f"  {table}.{col}: {cur.fetchone()[0]} Stave rows")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
