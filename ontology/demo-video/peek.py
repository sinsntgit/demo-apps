#!/usr/bin/env python3
"""Contact sheet of a recorded chapter: one frame near the end of each beat.   python3 peek.py ch02 [out.png] [cols]"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parent
cid = sys.argv[1]; out = sys.argv[2] if len(sys.argv) > 2 else f"/tmp/peek-{cid}.png"; cols = int(sys.argv[3]) if len(sys.argv) > 3 else 3
tl = json.loads((ROOT / "build" / "clips" / cid / "timeline.json").read_text())
fr = tl["frames"]
tiles = []
for b in tl["beats"]:
    t = b["abs"] + min(b["end"] - b["start"], b["audio"] + 0.2) * 0.92
    f = max((x for x in fr if x[0] <= t), key=lambda x: x[0], default=fr[0])
    im = Image.open(f[1]).resize((640, 360), Image.LANCZOS)
    ImageDraw.Draw(im).rectangle((0, 0, 70, 22), fill=(0, 0, 0)); ImageDraw.Draw(im).text((4, 4), b["key"], fill=(255, 255, 255))
    tiles.append(im)
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (640 * cols, 360 * rows), "white")
for i, im in enumerate(tiles): sheet.paste(im, ((i % cols) * 640, (i // cols) * 360))
sheet.save(out); print(out, len(tiles), "beats")
