import urllib.parse, os

ICON_DIR = r"C:\Users\shobhit.sharma\.claude\skills\ruprekha\icons"
NEEDED = ["dashboard", "file", "hr-compliance", "task", "alert-bulb", "help", "chevron-down", "back-arrow"]

for name in NEEDED:
    path = os.path.join(ICON_DIR, name + ".svg")
    with open(path, encoding="utf-8") as f:
        svg = f.read().strip()
    svg = svg.replace('"', "'")
    encoded = urllib.parse.quote(svg, safe="/:,;=. ")
    var_name = "--uzio-icon-" + name
    print(f'  {var_name}: url("data:image/svg+xml,{encoded}");')
