"""Export the approved Catstep Qianjing artwork into application icon formats."""

from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "branding" / "catstep-qianjing-approved.png"


def main() -> None:
    # Crop the presentation margin while retaining the approved artwork and tile.
    with Image.open(SOURCE) as source:
        image = source.convert("RGBA").crop((88, 96, 1160, 1168))
    image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    # Application tiles need transparent corners instead of the preview canvas.
    mask = Image.new("L", (4096, 4096))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 4095, 4095), radius=984, fill=255)
    image.putalpha(mask.resize(image.size, Image.Resampling.LANCZOS))

    icons = ROOT / "src-tauri" / "icons"
    image.save(icons / "icon.png", optimize=True)
    image.save(icons / "icon.ico", sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
    image.save(icons / "icon.icns", sizes=[(n, n) for n in (16, 32, 64, 128, 256, 512, 1024)])
    image.resize((256, 256), Image.Resampling.LANCZOS).save(ROOT / "web" / "maobu-mark.png", optimize=True)
    print("Exported approved artwork: PNG 1024, multi-size ICO, ICNS, and web PNG 256.")


if __name__ == "__main__":
    main()
