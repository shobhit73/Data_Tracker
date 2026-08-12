"""Decode the base64 Drive export dump of Shruti's 'DSP Implementation' tab,
save it as a real CSV, and print header + row-count stats (no full dump)."""
import csv
import json
import os

SRC = (
    r"C:\Users\shobhit.sharma\.claude\projects\C--Users-shobhit-sharma-Downloads-Uzio-Code"
    r"\020d2c3e-92b4-4469-b883-0cd65b12a2de\tool-results"
    r"\mcp-4333c226-b40d-431b-b6ee-b7000f17de5b-download_file_content-1786536728894.txt"
)
OUT_CSV = r"C:\Users\shobhit.sharma\Downloads\dsp-ops-dashboard\data\shruti_dsp_implementation.csv"

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
