"""Segmentation pipeline for the ChatGPT reference agent image.

Pipeline (v2 — adds text-strip crop + solid-body compacted variant):
  1. Load reference PNG (1024x1536, RGB, near-black background).
  2. Crop the baked-in text strips on the left (x:0-89) and right
     (x:870-1024), leaving the figure on a 780x1536 canvas.
  3. Build an alpha channel from luminance — dark pixels become
     transparent, bright pixels stay opaque, with a soft Gaussian edge.
  4. Save the cropped transparent figure as `agent-full.png`.
  5. Slice the figure vertically into 10 named bands. Each output is a
     full-canvas 780x1536 PNG with only its band opaque, so stacking
     all 10 reproduces the original.
  6. Build `agent-solid.png` — the same figure with floating fragments
     removed. Run morphological closing on the alpha mask to fuse near
     components, then BFS-label connected components and keep only the
     ones >= MIN_COMPONENT_PX. This is the "compacted" final state
     the welcome page cross-fades to at scroll-end.
"""
from __future__ import annotations

from collections import deque
from pathlib import Path
from PIL import Image, ImageFilter, ImageChops

REPO_ROOT = Path("/Users/conaugh/oasis-command-center")
SRC = REPO_ROOT / "public" / "welcome" / "agent-reference.png"
OUT_DIR = REPO_ROOT / "public" / "welcome" / "parts"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Source-image crop bounds. Per-row measurement of the longest bright
# pixel run shows the actual figure body extends x:320-801. Crop with a
# ~20px margin on each side gives us a tight 521x1536 canvas that holds
# the figure cleanly and discards every text label baked into the
# render (both the left-side numbered labels and the right-side caption).
CROP_LEFT = 300
CROP_RIGHT = 821  # exclusive
CROPPED_WIDTH = CROP_RIGHT - CROP_LEFT  # 521
SOURCE_HEIGHT = 1536

# Alpha-from-luminance threshold. The ChatGPT image's background sits
# near luminance 5-15; the figure's darkest internal shadow plates are
# ~30-50. 22 separates cleanly without nibbling internal detail.
LUMA_THRESHOLD = 22
ALPHA_BLUR_RADIUS = 0.8

# Compaction-image params: closing kernel + min-component size.
CLOSING_KERNEL = 5            # MaxFilter then MinFilter at this size
MIN_COMPONENT_PX = 1500       # drop components smaller than this
ALPHA_BINARY_THRESHOLD = 80   # alpha values above this count as "opaque"


def build_transparent_figure(src_rgb: Image.Image) -> Image.Image:
    """Convert RGB image to RGBA with dark background made transparent."""
    luma = src_rgb.convert("L")
    alpha = luma.point(lambda p: 255 if p > LUMA_THRESHOLD else 0)
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=ALPHA_BLUR_RADIUS))
    rgba = src_rgb.convert("RGBA")
    rgba.putalpha(alpha)
    return rgba


def slice_band(figure: Image.Image, name: str, y0: int, y1: int, feather: int = 24) -> None:
    """Save a full-canvas PNG where only rows [y0, y1) of `figure` show."""
    canvas = Image.new("RGBA", figure.size, (0, 0, 0, 0))
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
    figure_alpha = figure.split()[-1]
    combined_alpha = ImageChops.multiply(figure_alpha, mask)
    band = figure.copy()
    band.putalpha(combined_alpha)
    canvas.paste(band, (0, 0), band)
    out = OUT_DIR / f"{name}.png"
    canvas.save(out, optimize=True)
    print(f"  → {out.relative_to(REPO_ROOT)}  ({y0}-{y1}px)")


def build_solid_figure(figure: Image.Image) -> Image.Image:
    """Strip floating fragments by morphological closing + connected-component filtering.

    Steps:
      1. Closing: MaxFilter (dilate) → MinFilter (erode) at CLOSING_KERNEL.
         Fuses parts separated by small gaps so they label as one body.
      2. Threshold alpha to binary; BFS-label every connected region.
      3. Discard regions smaller than MIN_COMPONENT_PX (the floating chips).
      4. Apply the surviving regions back as a mask on the original figure.
    """
    width, height = figure.size
    alpha = figure.split()[-1]

    # Morphological closing on the alpha channel.
    closed = alpha.filter(ImageFilter.MaxFilter(CLOSING_KERNEL))
    closed = closed.filter(ImageFilter.MinFilter(CLOSING_KERNEL))

    # Binary mask + BFS labelling.
    binary = closed.point(lambda p: 1 if p > ALPHA_BINARY_THRESHOLD else 0)
    pixels = binary.load()
    labels = [[0] * width for _ in range(height)]
    component_sizes: dict[int, int] = {}
    next_label = 1

    print(f"  scanning {width}x{height} for connected components…")
    for y in range(height):
        for x in range(width):
            if pixels[x, y] == 1 and labels[y][x] == 0:
                # BFS to flood-fill this component.
                label = next_label
                next_label += 1
                queue: deque[tuple[int, int]] = deque([(x, y)])
                labels[y][x] = label
                size = 0
                while queue:
                    cx, cy = queue.popleft()
                    size += 1
                    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        nx, ny = cx + dx, cy + dy
                        if (
                            0 <= nx < width
                            and 0 <= ny < height
                            and pixels[nx, ny] == 1
                            and labels[ny][nx] == 0
                        ):
                            labels[ny][nx] = label
                            queue.append((nx, ny))
                component_sizes[label] = size

    keep_labels = {lab for lab, sz in component_sizes.items() if sz >= MIN_COMPONENT_PX}
    print(
        f"  found {len(component_sizes)} components; keeping {len(keep_labels)} "
        f">= {MIN_COMPONENT_PX}px"
    )

    # Build mask from surviving components.
    solid_mask = Image.new("L", figure.size, 0)
    mp = solid_mask.load()
    for y in range(height):
        row_labels = labels[y]
        for x in range(width):
            if row_labels[x] in keep_labels:
                mp[x, y] = 255

    # Apply mask back over the ORIGINAL (pre-closing) alpha so the body
    # keeps its crisp original edges, only the floating chips are gone.
    final_alpha = ImageChops.multiply(alpha, solid_mask)
    solid = figure.copy()
    solid.putalpha(final_alpha)
    return solid


def main() -> None:
    print(f"Loading {SRC.relative_to(REPO_ROOT)}")
    src_rgb = Image.open(SRC).convert("RGB")
    print(f"  source size: {src_rgb.size}")

    # Crop text strips.
    cropped_rgb = src_rgb.crop((CROP_LEFT, 0, CROP_RIGHT, SOURCE_HEIGHT))
    print(f"  cropped to {cropped_rgb.size} (removed left x:0-{CROP_LEFT}, right x:{CROP_RIGHT}-{src_rgb.size[0]})")

    figure = build_transparent_figure(cropped_rgb)
    figure.save(OUT_DIR / "agent-full.png", optimize=True)
    print("  → public/welcome/parts/agent-full.png (cropped, transparent silhouette)")

    # 10 vertical bands. Y-coords match the original (figure layout
    # didn't move vertically, only horizontally).
    bands = [
        ("01-head",            0,    230),
        ("02-neural-cube",     230,  360),
        ("03-neural-disc",     360,  490),
        ("04-memory-ring",     490,  640),
        ("05-sensors",         640,  760),
        ("06-reasoning-torso", 760,  960),
        ("07-communication",   960,  1100),
        ("08-ethics-hip",      1100, 1260),
        ("09-body-pelvis",     1260, 1410),
        ("10-activation",      1410, 1536),
    ]
    print("Slicing bands:")
    for name, y0, y1 in bands:
        slice_band(figure, name, y0, y1)

    print("Building compacted solid figure (fragments stripped):")
    solid = build_solid_figure(figure)
    solid_path = OUT_DIR / "agent-solid.png"
    solid.save(solid_path, optimize=True)
    print(f"  → {solid_path.relative_to(REPO_ROOT)}")

    print("\nDone. 10 banded layers + agent-full + agent-solid in public/welcome/parts/")


if __name__ == "__main__":
    main()
