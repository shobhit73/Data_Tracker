"""Decode the base64 Drive export dump of Shruti's 'DSP Implementation' tab,
save it as a real CSV, and print header + row-count stats (no full dump).

Usage:
    python decode_dsp_sheet.py <path-to-download_file_content-dump.txt>

The dump is whatever the Drive connector's download_file_content wrote (a JSON
envelope with base64 in `content`). Its filename changes every run, so the path
must be passed in — hardcoding one session's tool-result path made this script
unrunnable on any later run, including the scheduled refresh.
"""
import csv
import json
import os
import sys

OUT_CSV = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "shruti_dsp_implementation.csv",
)

if len(sys.argv) < 2:
    sys.exit(
        "Pass the Drive download dump path.\n"
        "  1. Call download_file_content on file 1GRnfKMp4tcjGXWhkx5rpRKQD8eadikZPNqeufctoXsI\n"
        "     with exportMimeType 'text/csv'\n"
        "  2. python decode_dsp_sheet.py <the tool-results .txt path it saved>"
    )
SRC = sys.argv[1]

with open(SRC, encoding="utf-8") as f:
    payload = json.load(f)

import base64

raw = base64.b64decode(payload["content"])
os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
with open(OUT_CSV, "wb") as f:
    f.write(raw)

with open(OUT_CSV, encoding="utf-8-sig", newline="") as f:
    reader = csv.reader(f)
    header = next(reader)
    rows = list(reader)

print("Decoded bytes:", len(raw))
print("Header columns:", len(header))
for i, h in enumerate(header):
    print(f"  [{i}] {h!r}")
print("Data rows:", len(rows))
print("First data row (col0..col9):", rows[0][:10] if rows else None)
