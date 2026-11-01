"""Regenerate compact alpha masks from the existing 24px toolbar PNG assets.

Requires Pillow only for this developer command; the browser has no PNG/tint
dependency and embeds the generated masks.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'assets/icons'
# Rasterize download.svg at 4x for smooth round caps. The progress ring hides
# this glyph while downloads are active; its ordinary tray icon stays intact.
scale = 4
download = Image.new('RGBA', (24 * scale, 24 * scale))
draw = ImageDraw.Draw(download)
color = (59, 66, 82, 255)
for points in [((12, 3), (12, 15)), ((7, 10), (12, 15), (17, 10)), ((5, 17), (5, 21), (19, 21), (19, 17))]:
    draw.line([(round(x * scale), round(y * scale)) for x, y in points], fill=color, width=2 * scale, joint='curve')
    for x, y in points:
        draw.ellipse(((x - 1) * scale, (y - 1) * scale, (x + 1) * scale, (y + 1) * scale), fill=color)
download.resize((24, 24), Image.Resampling.LANCZOS).save(root / 'download.png')
for name in ('back', 'forward', 'reload', 'stop', 'download', 'menu'):
    with Image.open(root / f'{name}.png') as image:
        assert image.size == (24, 24)
        (root / f'{name}.alpha').write_bytes(image.convert('RGBA').getchannel('A').tobytes())
