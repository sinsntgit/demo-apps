#!/usr/bin/env python3
"""Thumbnail for the demo videos -> build/out/thumbnail.png (1920x1080) and thumbnail.jpg"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
B = Path(__file__).resolve().parent / "build"
F = "/usr/share/fonts/opentype/inter/Inter-%s.otf"
W, H = 1920, 1080
tl = json.loads((B / "clips/ch04/timeline.json").read_text())
beat = [x for x in tl["beats"] if x["key"] == "ch04.01"][0]
fr = max((f for f in tl["frames"] if f[0] <= beat["abs"] + 7), key=lambda f: f[0])[1]
shot = Image.open(fr).convert("RGB")
bg = Image.new("RGB", (W, H))
d = ImageDraw.Draw(bg)
for y in range(H):
    t = y / H; d.line([(0, y), (W, y)], fill=(int(10 + 8 * t), int(22 + 14 * t), int(40 + 22 * t)))
glow = Image.new("RGB", (W, H), (0, 0, 0)); g = ImageDraw.Draw(glow)
g.ellipse((1000, 150, 1900, 1000), fill=(20, 120, 112)); glow = glow.filter(ImageFilter.GaussianBlur(160))
bg = Image.blend(bg, Image.eval(glow, lambda v: v), 0.0); bg = Image.composite(bg, bg, Image.new("L", (W, H), 255))
from PIL import ImageChops
bg = ImageChops.add(bg, glow.point(lambda v: int(v * 0.45)))
# screenshot card
cw = 1040; ch = int(cw * shot.height / shot.width)
card = shot.resize((cw, ch), Image.LANCZOS)
x0, y0 = 800, (H - ch) // 2 + 20
sh = Image.new("RGBA", (cw + 120, ch + 120), (0, 0, 0, 0))
ImageDraw.Draw(sh).rounded_rectangle((60, 70, cw + 60, ch + 70), 28, fill=(0, 0, 0, 170))
sh = sh.filter(ImageFilter.GaussianBlur(26)); bg.paste(sh, (x0 - 60, y0 - 60), sh)
m = Image.new("L", card.size, 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, cw - 1, ch - 1), 24, fill=255)
bg.paste(card, (x0, y0), m)
d = ImageDraw.Draw(bg)
d.rounded_rectangle((x0, y0, x0 + cw, y0 + ch), 24, outline=(20, 184, 166), width=4)
f = lambda w, s: ImageFont.truetype(F % w, s)
d.rounded_rectangle((90, 110, 90 + 330, 170), 30, fill=(20, 184, 166))
d.text((255, 140), "PRODUCT DEMO", font=f("Bold", 30), fill=(4, 32, 28), anchor="mm")
y = 230
for line, col in [("Build, test", (255, 255, 255)), ("and use", (255, 255, 255)), ("ontologies", (45, 212, 191)), ("with AI", (255, 255, 255))]:
    d.text((90, y), line, font=f("Bold", 112), fill=col); y += 124
d.text((94, y + 20), "From shared words to a queryable", font=f("SemiBold", 34), fill=(190, 208, 225)); d.text((94, y + 64), "knowledge graph", font=f("SemiBold", 34), fill=(190, 208, 225))
d.text((94, H - 112), "OntoStudio", font=f("Bold", 44), fill=(255, 255, 255))
d.text((94, H - 62), "syncsense.in", font=f("SemiBold", 32), fill=(45, 212, 191))
out = B / "out"
bg.save(out / "thumbnail.png"); bg.save(out / "thumbnail.jpg", quality=92)
print("ok")
