#!/usr/bin/env python3
"""Tile every render screenshot into one contact sheet.

    python3 scripts/contact-sheet.py                        # ORACURA render output
    python3 scripts/contact-sheet.py reports/power-bi/acme  # a scaffolded report
    python3 scripts/contact-sheet.py reports/power-bi/oracura-render  # explicit render dir

Reads <render>/shots/*.png and writes <render>/contact-sheet.png. Requires Pillow.
"""
import glob
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
project = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "reports/power-bi/oracura")
# ORACURA renders to a sibling <project>-render/; a scaffolded report renders inside
# its own folder as render/. Take whichever actually holds screenshots.
candidates = [project, os.path.join(project, "render"), f"{project.rstrip('/')}-render"]
render = next((c for c in candidates if os.path.isdir(os.path.join(c, "shots"))), os.path.join(project, "render"))

shots = sorted(glob.glob(os.path.join(render, "shots/*.png")))
if not shots:
    sys.exit(f"no screenshots in {render}/shots - run scripts/screenshot-render.mjs first")

COLS, THUMB_W, PAD, LABEL_H = 4, 320, 12, 22
thumbs = []
for path in shots:
    image = Image.open(path).convert("RGB")
    height = int(image.height * THUMB_W / image.width)
    thumbs.append((os.path.basename(path), image.resize((THUMB_W, height), Image.LANCZOS)))

rows = (len(thumbs) + COLS - 1) // COLS
width = COLS * (THUMB_W + PAD) + PAD
height = rows * (thumbs[0][1].height + LABEL_H + PAD) + PAD
sheet = Image.new("RGB", (width, height), (30, 26, 22))
draw = ImageDraw.Draw(sheet)
for index, (name, thumb) in enumerate(thumbs):
    x = PAD + (index % COLS) * (THUMB_W + PAD)
    y = PAD + (index // COLS) * (thumb.height + LABEL_H + PAD)
    sheet.paste(thumb, (x, y + LABEL_H))
    draw.text((x + 2, y + 4), name, fill=(230, 220, 205))
out = os.path.join(render, "contact-sheet.png")
sheet.save(out)
print(f"{len(thumbs)} pages -> {out} ({width}x{height})")
