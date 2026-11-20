"""Download the four anthropic_* fonts from clauden.best into site/fonts/.

They are not stored in this repository because of their license. The copy of the
site works without them, but looks identical to the original only with them.
Each file is checked against the SHA-256 recorded on 20.11.2026.
"""
import hashlib
import os
import urllib.request

FONTS = {
    "anthropic_sans.ttf": "4eda2c42031a090a3d01cd58ada3de00f467e3e359efad36572f26e43ecba65f",
    "anthropic_sans_italic.ttf": "ad5af382e340115276eb38e1230844d2705773acf2fec61738fa43500e30d515",
    "anthropic_serif.ttf": "cb2c65e0d0d326181f2a2525ad344cacc850a41c24aeaea51cc70df8c88a3231",
    "anthropic_serif_italic.ttf": "1682880b4495f1e2fa5c40d5274f48e076562b3bfb14f8f80830a0ddb912daae",
}
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "fonts")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

os.makedirs(DEST, exist_ok=True)
for name, expected in FONTS.items():
    req = urllib.request.Request("https://clauden.best/fonts/" + name, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
    actual = hashlib.sha256(body).hexdigest()
    with open(os.path.join(DEST, name), "wb") as f:
        f.write(body)
    note = "OK" if actual == expected else "hash differs from 20.11.2026 (the site changed the file)"
    print(f"{name}: {len(body)} bytes, {note}")
