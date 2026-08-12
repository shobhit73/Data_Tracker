"""Shared Supabase (Postgres) connector for the DSP Ops Dashboard project.

Credentials live OUTSIDE this repo, under the Claude memory secrets dir
(gitignored, never committed): supabase-creds.json -> key "dsp-ops-dashboard".

Usage:
    from supabase_helper import connect
    conn = connect()
    cur = conn.cursor()
    cur.execute("select 1")
"""
import json
import os

import psycopg2

CREDS_PATH = (
    r"C:\Users\shobhit.sharma\.claude\projects\C--Users-shobhit-sharma-Downloads-Uzio-Code"
    r"\memory\_secrets\supabase-creds.json"
)
PROJECT_KEY = "dsp-ops-dashboard"


def _creds():
    with open(CREDS_PATH, encoding="utf-8") as f:
        return json.load(f)[PROJECT_KEY]


def connect():
    c = _creds()
    return psycopg2.connect(
        host=c["host"],
        port=c["port"],
        dbname=c["dbname"],
        user=c["user"],
        password=c["password"],
        sslmode="require",
    )
