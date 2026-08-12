"""Download the currently-deployed dashboard HTML and diff it against the local
site/index.html, so a local edit can never silently overwrite work that was
deployed from somewhere else. Writes the live copy to scripts/_live_index.html
for inspection — it does NOT touch site/index.html."""
import difflib
import os
import urllib.request

URL = "https://data-tracker-one.vercel.app/index.html"
HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL = os.path.join(os.path.dirname(HERE), "site", "index.html")
OUT = os.path.join(HERE, "_live_index.html")

req = urllib.request.Request(URL, headers={"Cache-Control": "no-cache"})
with urllib.request.urlopen(req, timeout=60) as r:
    live = r.read().decode("utf-8")

with open(OUT, "w", encoding="utf-8") as f:
    f.write(live)

with open(LOCAL, encoding="utf-8") as f:
    local = f.read()

print("live chars :", len(live))
print("local chars:", len(local))
print("identical  :", live == local)

live_lines = live.splitlines()
local_lines = local.splitlines()
sm = difflib.SequenceMatcher(None, local_lines, live_lines)
only_live, only_local = 0, 0
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag in ("insert", "replace"):
        only_live += j2 - j1
    if tag in ("delete", "replace"):
        only_local += i2 - i1
print(f"lines only in LIVE (would be lost if we deploy local): {only_live}")
print(f"lines only in LOCAL (not yet deployed):                {only_local}")

for marker in ("renderDocuments", "view-documents", "data-view=\"documents\"",
               "SocCode", "W2DeliveryMethod", "stat-tile", "table-shell"):
    print(f"  {marker:26s} live={marker in live!s:5s} local={marker in local!s}")
