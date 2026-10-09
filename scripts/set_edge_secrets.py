"""Push the prod-refresh function's secrets, without any of them touching the
shell.

WHY NOT JUST RUN THE CLI BY HAND
    `supabase secrets set NEURONOPS_PASSWORD=...` puts a prod password into
    PowerShell history and, for as long as the process lives, into the process
    list where any other user on the box can read it. Nine values typed by hand
    is also nine chances to paste the wrong one.

    So this reads the five values that are already cached locally, asks only
    for the two that are not, writes them to a temp env file OUTSIDE the repo,
    hands the CLI `--env-file`, and deletes the file in a finally block.

Nothing is printed. A value is only ever echoed as its length, so a run can be
checked without reading a secret off the screen.

Run:  python set_edge_secrets.py
      python set_edge_secrets.py --dry-run     # show the names, call nothing
"""
import getpass
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
SECRETS = os.path.join(
    os.path.expanduser("~"), ".claude", "projects",
    "C--Users-shobhit-sharma-Downloads-Uzio-Code", "memory", "_secrets")

DASH_REF = "nqiyiherkzlhorsnyeni"          # ours: hosts the function, takes the writes
CRM_REF = "iupwughtplmvflfjetyg"           # Rohit's: issues the logins we verify


def cached(filename, *keys):
    with open(os.path.join(SECRETS, filename), encoding="utf-8") as fh:
        env = json.load(fh)["prod"]
    return [env[k] for k in keys]


def main():
    dry = "--dry-run" in sys.argv[1:]

    nu, np_ = cached("neuronops-creds.json", "username", "password")
    ou, op, of = cached("onboarding-creds.json", "username", "password", "fein")

    # Neither of these is cached anywhere on this machine. DASH_SERVICE_KEY
    # lives only in Supabase (Project Settings > API Keys) and in the Apps
    # Script property of the same name; CRM_ANON_KEY is in the CRM's own
    # frontend as CONFIG.SUPABASE_ANON_KEY.
    dash_key = os.environ.get("DASH_SERVICE_KEY") or (
        "" if dry else getpass.getpass("DASH_SERVICE_KEY (sb_secret_... from our project): "))
    crm_anon = os.environ.get("CRM_ANON_KEY") or (
        "" if dry else getpass.getpass("CRM_ANON_KEY (the CRM's CONFIG.SUPABASE_ANON_KEY): "))

    values = {
        "NEURONOPS_USERNAME": nu,
        "NEURONOPS_PASSWORD": np_,
        "ONBOARDING_USERNAME": ou,
        "ONBOARDING_PASSWORD": op,
        "ONBOARDING_FEIN": of,
        "DASH_URL": f"https://{DASH_REF}.supabase.co",
        "DASH_SERVICE_KEY": dash_key,
        "CRM_AUTH_URL": f"https://{CRM_REF}.supabase.co",
        "CRM_ANON_KEY": crm_anon,
    }

    for name, v in values.items():
        print(f"  {name:22} {'(empty!)' if not v else str(len(v)) + ' chars'}")
    missing = [k for k, v in values.items() if not v]
    if missing and not dry:
        sys.exit("refusing to send an empty secret: " + ", ".join(missing))
    if dry:
        print("\nDRY RUN - nothing sent.")
        return

    # Outside the repo, and gone before this returns either way.
    fd, path = tempfile.mkstemp(prefix="edge-secrets-", suffix=".env")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            for k, v in values.items():
                fh.write(f"{k}={v}\n")
        cmd = ["npx", "supabase@latest", "secrets", "set",
               "--project-ref", DASH_REF, "--env-file", path]
        print("\n$ " + " ".join(cmd))
        rc = subprocess.call(cmd, cwd=PROJECT, shell=(os.name == "nt"))
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    sys.exit(rc)


if __name__ == "__main__":
    main()
