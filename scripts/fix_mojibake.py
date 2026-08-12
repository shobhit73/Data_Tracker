"""Repair double-encoded UTF-8 (mojibake) and strip a stray BOM from site/index.html.

Cause: a PowerShell edit did `Get-Content -Raw` (which decodes using the system
ANSI codepage when the file has no BOM) then `Set-Content -Encoding utf8`, so
every non-ASCII character got encoded a second time. That same Set-Content also
prepended a UTF-8 BOM.

Approach: rather than trying to *recognise* mojibake with a regex character
class -- which is fragile, because the continuation characters land on C1
control codes (U+0080-U+009F) that are invisible in source and get silently
dropped by editors -- we *generate* the corrupted form of every character we
care about and do plain string replacement.

    mojibake_of(ch) == ch.encode('utf-8').decode('latin-1')

latin-1 (not cp1252) is the right inverse here: it maps all 256 byte values,
including the ones cp1252 leaves undefined, which is why bytes like 0x9D
survived the original corruption as raw control characters.
"""
import os

SITE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "index.html")

# Every non-ASCII character this page legitimately contains.
CHARS = [
    "’",  # right single quote / apostrophe
    "‘",  # left single quote
    "“",  # left double quote
    "”",  # right double quote
    "–",  # en dash
    "—",  # em dash
    "…",  # ellipsis
    "·",  # middot
    "→",  # rightwards arrow
    " ",  # nbsp
    "✓",  # check mark
    "✗",  # ballot x
    "é",  # e-acute (names)
]


def _byte_to_char(b):
    """Reproduce .NET's codepage-1252 decode: use the cp1252 mapping where one
    exists, and pass undefined bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D) straight
    through as the matching control character, the way latin-1 would.

    Getting this exactly right matters -- a pure latin-1 model turns 0x80 into
    U+0080 instead of the euro sign, and a pure cp1252 model can't represent
    0x9D at all, so both produce search strings that never match the file."""
    try:
        return bytes([b]).decode("cp1252")
    except UnicodeDecodeError:
        return chr(b)


def mojibake_of(ch):
    return "".join(_byte_to_char(b) for b in ch.encode("utf-8"))


def main():
    raw = open(SITE, "rb").read()
    had_bom = raw[:3] == b"\xef\xbb\xbf"
    txt = raw.decode("utf-8-sig")

    # Longest-first so a 3-char corrupted run is never partly eaten by a 2-char one.
    table = sorted(((mojibake_of(c), c) for c in CHARS), key=lambda kv: -len(kv[0]))

    fixes = {}
    for bad, good in table:
        if bad == good or bad not in txt:
            continue
        fixes[bad] = (good, txt.count(bad))
        txt = txt.replace(bad, good)

    if not fixes and not had_bom:
        print("Clean -- no mojibake, no BOM.")
        return

    for bad, (good, n) in fixes.items():
        print("  {} x  {!r} -> {!r}".format(n, bad, good))
    if had_bom:
        print("  stripped UTF-8 BOM")

    with open(SITE, "w", encoding="utf-8", newline="") as f:
        f.write(txt)
    print("\nRewrote {} ({} chars)".format(SITE, len(txt)))


if __name__ == "__main__":
    main()
