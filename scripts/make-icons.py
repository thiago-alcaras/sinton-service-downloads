from pathlib import Path
import platform
import subprocess
import sys
import tempfile

from PIL import Image

root = Path(__file__).resolve().parents[1]
source = root / "assets" / "sinton-logo.png"
image = Image.open(source).convert("RGBA")
side = min(image.size)
left = (image.width - side) // 2
top = (image.height - side) // 2
image = image.crop((left, top, left + side, top + side))

icon_path = root / "assets" / "sinton.png"
image.resize((512, 512), Image.Resampling.LANCZOS).save(icon_path, optimize=True)
image.save(root / "assets" / "sinton.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

if platform.system() == "Darwin":
    iconset = root / "assets" / "sinton.iconset"
    iconset.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 128, 256, 512):
        rendered = image.resize((size, size), Image.Resampling.LANCZOS)
        rendered.save(iconset / f"icon_{size}x{size}.png")
        image.resize((size * 2, size * 2), Image.Resampling.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(root / "assets" / "sinton.icns")], check=True)
