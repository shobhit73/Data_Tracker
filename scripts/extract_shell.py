"""Pull out the reusable pieces of the static dashboard (CSS + sidebar/header
shell) so the new live version can reuse the exact same UZIO DS styling
without hand-retyping ~300 lines of CSS."""
import re

SRC = r"C:\Users\shobhit.sharma\Downloads\dsp-ops-dashboard\dashboard\dsp_dashboard.html"
OUT_STYLE = r"C:\Users\shobhit.sharma\Downloads\dsp-ops-dashboard\scripts\_extracted_style.html"
OUT_SHELL = r"C:\Users\shobhit.sharma\Downloads\dsp-ops-dashboard\scripts\_extracted_shell.html"

with open(SRC, encoding="utf-8") as f:
    content = f.read()

style_match = re.search(r"<style>.*?</style>", content, re.DOTALL)
with open(OUT_STYLE, "w", encoding="utf-8") as f:
    f.write(style_match.group(0))
print("style block:", len(style_match.group(0)), "chars")

aside_match = re.search(r'<aside class="uzio-sidebar-x">.*?</aside>', content, re.DOTALL)
header_match = re.search(r'<header class="uzio-header">.*?</header>', content, re.DOTALL)
with open(OUT_SHELL, "w", encoding="utf-8") as f:
    f.write(aside_match.group(0) + "\n\n" + header_match.group(0))
print("aside:", len(aside_match.group(0)), "chars")
print("header:", len(header_match.group(0)), "chars")
