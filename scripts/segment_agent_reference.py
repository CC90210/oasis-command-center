"""One-shot segmentation pipeline for the ChatGPT reference agent image.

Pipeline:
  1. Load reference PNG (1024x1536, RGB, near-black background).
  2. Build alpha channel from luminance: dark pixels → transparent, bright
     pixels → opaque. Soft edge via blur so cuts don't look pixelated.
  3. Save the full transparent figure as `agent-full.png`.
  4. Slice the transparent figure into named regions by vertical band.
     Each output is a full 1024x1536 canvas with only its region opaque,
     so layers stack to recreate the original image pixel-for-pixel.
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageFilter, ImageChops

REPO_ROOT = Path("/Users/conaugh/oasis-command-center")
SRC = REPO_ROOT / "public" / "welcome" / "agent-reference.png"
OUT_DIR = REPO_ROOT / "public" / "welcome" / "parts"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Luminance threshold below which pixels become transparent.
# The ChatGPT image's background is near-black (~5-15 luminance); the
# figure's darkest internal shadow plates are ~30-50. Threshold of 22
# cleanly separates background from figure without nibbling internal
# detail.
LUMA_THRESHOLD = 22
# Soft edge: blur the alpha mask before re-applying so transparency
# fades smoothly instead of hard-cutting at the threshold.
ALPHA_BLUR_RADIUS = 0.8


def build_transparent_figure(src: Path) -> Image.Image:
    """Return RGBA copy of src with dark background made transparent."""
    rgb = Image.open(src).convert("RGB")
    luma = rgb.convert("L")
    # Pixels brighter than threshold become opaque (255), darker → 0.
    alpha = luma.point(lambda p: 255 if p > LUMA_THRESHOLD else 0)
    # Soft-edge the mask so cuts aren't jagged.
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=ALPHA_BLUR_RADIUS))
    rgba = rgb.convert("RGBA")
    rgba.putalpha(alpha)
    return rgba


def slice_band(figure: Image.Image, name: str, y0: int, y1: int, feather: int = 24) -> None:
    """Save a full-canvas PNG where only rows [y0, y1) of `figure` are visible.

    Vertical edges are feathered so adjacent bands blend instead of showing a
    sharp horizontal seam when stacked.
    """
    canvas = Image.new("RGBA", figure.size, (0, 0, 0, 0))
    # Build a vertical feather mask: 0 outside the band, 255 inside, with a
    # smooth ramp of `feather` px on each edge.
    mask = Image.new("L", figure.size, 0)
    pixels = mask.load()
    width, height = figure.size
    for y in range(height):
        if y < y0 - feather or y >= y1 + feather:
            value = 0
        elif y < y0:
            value = int(255 * (y - (y0 - feather)) / feather)
        elif y >= y1:
            value = int(255 * ((y1 + feather) - y) / feather)
        else:
            value = 255
        for x in range(width):
            pixels[x, y] = value
    # Multiply figure's existing alpha by the band mask.
    figure_alpha = figure.split()[-1]
    combined_alpha = ImageChops.multiply(figure_alpha, mask)
    band = figure.copy()
    band.putalpha(combined_alpha)
    canvas.paste(band, (0, 0), band)
    out = OUT_DIR / f"{name}.png"
    canvas.save(out, optimize=True)
    print(f"  → {out.relative_to(REPO_ROOT)}  ({y0}-{y1}px)")


def main() -> None:
    print(f"Loading {SRC.relative_to(REPO_ROOT)}")
    figure = build_transparent_figure(SRC)
    figure.save(OUT_DIR / "agent-full.png", optimize=True)
    print(f"  → public/welcome/parts/agent-full.png (full transparent figure)")

    # 9 vertical bands matching the reference image's numbered subsystems.
    # Coordinates measured against the 1024×1536 source. Bands overlap
    # slightly via the feather so they blend seamlessly when re-stacked.
    bands = [
        ("01-head",            0,    230),  # Skull + helmet
        ("02-neural-cube",     230,  360),  # Floating cube
        ("03-neural-disc",     360,  490),  # Diamond/disc array
        ("04-memory-ring",     490,  640),  # Memory torus
        ("05-sensors",         640,  760),  # Sensor band / collarbone
        ("06-reasoning-torso", 760,  960),  # Chest + shoulders
        ("07-communication",   960,  1100), # Arms + comms hub
        ("08-ethics-hip",      1100, 1260), # Hip module + ethics
        ("09-body-pelvis",     1260, 1410), # Pelvis cluster + thighs
        ("10-activation",      1410, 1536), # Podium
    ]
    print("Slicing bands:")
    for name, y0, y1 in bands:
        slice_band(figure, name, y0, y1)

    print("\nDone. 10 layered PNGs in public/welcome/parts/")


if __name__ == "__main__":
    main()
