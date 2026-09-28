"""One-time import: DSP Ops dashboard Open Items -> CRM ad-hoc tasks.

Destined for the CRM repo's scripts/ folder (https://github.com/Rohit-Kaushik-git/CRM)
— written in that repo's house style (stdlib only, .env for credentials) so it can
be dropped in unchanged. Plan: dsp-ops-dashboard/docs/plans/2026-09-28-phase1-open-items-to-crm.md.

Input is the JSON dump made by dsp-ops-dashboard/scripts/export_open_items.py.
Each row becomes one ad-hoc task (template_id null) on the matching CRM client:

  - title            -> tasks.title, with the leading "<Client> - " prefix stripped
                        (the prefix is what resolves the client)
  - status Open/Done -> same; completed_at -> done_date
  - due_date         -> due_date
  - pending_for containing "Data Team" -> assigned_team 'Data Team';
    "Implementation" -> left null (defaults to the client's implementor)
  - everything else (description, severity, pending_for verbatim, external
    contact in `assignee`, completed_by) -> the task's first note, so nothing
    is lost and the append-only history opens with full provenance

Safety:
  - Any client the map cannot resolve ABORTS the whole run (all problems are
    reported first). Nothing is guessed and no client is ever created.
  - Idempotent: a client that already has an ad-hoc task with the same title
    is skipped, so re-runs add nothing.
  - The sheet-sync's conflict rule is unaffected: it only writes template
    tasks; these are all ad-hoc.

Usage:
  python import_open_items.py <backup.json> --offline   # no CRM access needed:
                                                        # preview the mapping only
  python import_open_items.py <backup.json> --dry-run   # resolve against the live
                                                        # CRM, report, write nothing
  python import_open_items.py <backup.json>             # the real run

Env (CRM project's values, NOT the dashboard's): SUPABASE_URL,
SUPABASE_SERVICE_KEY — real environment variables win; .env next to this
script or in its parent directory fills gaps.
"""
import datetime
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# Title prefix (before " - ") -> the client's dsp_name in the CRM. Resolution
# against the live clients table is normalized-exact first, then unique
# substring, so "First Line" also matches a "First Line Logistics LLC".
# None = deliberately NOT migrated: Flash Hub predates the CRM's TT-live-date
# cutoff and is absent from its clients table; creating it would auto-generate
# 17 open template tasks just to hold two already-Done history items. Those two
# stay archived in the backup JSON instead (decision 2026-09-28).
CLIENT_MAP = {
    "Stave": "Stave Delivery",
    "Stave Delivery": "Stave Delivery",
    "First Line": "First Line Logistics",
    "InnovDel": "InnovDel",
    "Flash Hub": None,
    "High Distinction": "High Distinction",
}


def load_env():
    conf = {}
    for root in (HERE, os.path.dirname(HERE)):
        env_path = os.path.join(root, ".env")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        conf.setdefault(k.strip(), v.strip())
    conf.update({k: v for k, v in os.environ.items() if k.startswith("SUPABASE_")})
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not conf.get(key):
            sys.exit(f"Missing {key} (set env var or .env) — the CRM project's, "
                     "not the dashboard's. Or use --offline for a preview.")
    return conf


def rest(conf, method, path, body=None, prefer="return=representation"):
    req = urllib.request.Request(
        conf["SUPABASE_URL"] + "/rest/v1/" + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
    )
    req.add_header("apikey", conf["SUPABASE_SERVICE_KEY"])
    req.add_header("Authorization", "Bearer " + conf["SUPABASE_SERVICE_KEY"])
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:500]}")


def norm(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def resolve_client(mapped_name, clients):
    """CLIENT_MAP value -> client row. Exact normalized match first, then a
    substring match — but only when it is unique. None if unresolvable."""
    want = norm(mapped_name)
    exact = [c for c in clients if norm(c["dsp_name"]) == want or norm(c.get("short_code")) == want]
    if len(exact) == 1:
        return exact[0]
    partial = [c for c in clients if want in norm(c["dsp_name"])]
    if len(partial) == 1:
        return partial[0]
    return None


def build_note(row, today):
    lines = [
        "Migrated from the DSP Ops dashboard's Open Items on %s "
        "(item #%s, added %s)." % (today, row["id"], row.get("date_added") or "?")
    ]
    facts = []
    if row.get("severity"):
        facts.append("Severity: " + row["severity"])
    if row.get("pending_for"):
        facts.append("Pending for: " + row["pending_for"])
    if facts:
        lines.append(" | ".join(facts))
    if row.get("assignee"):
        lines.append("Waiting on: " + row["assignee"])
    if row.get("completed_by") or row.get("completed_at"):
        lines.append("Completed by %s at %s." % (
            row.get("completed_by") or "?", (row.get("completed_at") or "?")[:10]))
    if row.get("description"):
        lines.append("")
        lines.append(row["description"])
    return "\n".join(lines)


def plan_rows(rows, today):
    """Source rows -> (plans, problems). A plan carries everything the insert
    needs except the resolved client id."""
    plans, problems = [], []
    for row in rows:
        if " - " not in (row.get("title") or ""):
            problems.append("item #%s: title has no '<Client> - ' prefix: %r"
                            % (row["id"], row.get("title")))
            continue
        prefix, rest_title = row["title"].split(" - ", 1)
        prefix = prefix.strip()
        if prefix not in CLIENT_MAP:
            problems.append("item #%s: no CLIENT_MAP entry for prefix %r"
                            % (row["id"], prefix))
            continue
        mapped = CLIENT_MAP[prefix]
        if mapped is None:
            print("ARCHIVE #%-3s %r stays in the backup JSON only (client not in CRM, see CLIENT_MAP)"
                  % (row["id"], row["title"]))
            continue
        if row["status"] not in ("Open", "Done"):
            problems.append("item #%s: unexpected status %r" % (row["id"], row["status"]))
            continue
        task = {"title": rest_title.strip(), "status": row["status"]}
        if row.get("due_date"):
            task["due_date"] = row["due_date"][:10]
        if row["status"] == "Done" and row.get("completed_at"):
            task["done_date"] = row["completed_at"][:10]
        if "data team" in (row.get("pending_for") or "").lower():
            task["assigned_team"] = "Data Team"
        plans.append({"item": row["id"], "client": mapped, "task": task,
                      "note": build_note(row, today)})
    return plans, problems


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if len(args) != 1:
        sys.exit("Usage: python import_open_items.py <backup.json> [--dry-run|--offline]")
    offline = "--offline" in flags
    dry = ("--dry-run" in flags) or offline

    with open(args[0], encoding="utf-8") as f:
        rows = json.load(f)
    today = datetime.date.today().isoformat()
    plans, problems = plan_rows(rows, today)

    conf = clients = None
    if not offline:
        conf = load_env()
        clients = rest(conf, "GET", "clients?select=id,dsp_name,short_code")
        for p in plans:
            c = resolve_client(p["client"], clients)
            if c is None:
                problems.append("item #%s: %r matches no single CRM client"
                                % (p["item"], p["client"]))
            else:
                p["client_id"], p["client"] = c["id"], c["dsp_name"]

    if problems:
        print("PROBLEMS — nothing will be written until every one is fixed:")
        for p in problems:
            print("  !", p)
        sys.exit(1)

    mode = "OFFLINE PREVIEW" if offline else ("DRY RUN" if dry else "LIVE")
    print("%s - %d item(s) from %s\n" % (mode, len(plans), os.path.basename(args[0])))
    imported = skipped = 0
    for p in plans:
        t = p["task"]
        if not offline:
            existing = rest(conf, "GET",
                            "tasks?client_id=eq.%d&template_id=is.null&select=title" % p["client_id"])
            if any(norm(e["title"]) == norm(t["title"]) for e in existing):
                print("SKIP  #%-3s %-24s already has ad-hoc task %r" % (p["item"], p["client"], t["title"]))
                skipped += 1
                continue
        detail = ", ".join("%s=%s" % (k, v) for k, v in t.items() if k != "title")
        print("%s #%-3s %-24s %r\n      (%s)" % ("PLAN " if dry else "ADD  ",
                                                 p["item"], p["client"], t["title"], detail))
        for line in p["note"].splitlines():
            print("      | " + line)
        if not dry:
            body = dict(t, client_id=p["client_id"])
            task = rest(conf, "POST", "tasks", [body])[0]
            rest(conf, "POST", "task_notes", [{"task_id": task["id"], "note": p["note"]}],
                 prefer="return=minimal")
            imported += 1
        print()
    print("done: %d imported, %d skipped, %d planned"
          % (imported, skipped, len(plans) - imported - skipped))


if __name__ == "__main__":
    main()
