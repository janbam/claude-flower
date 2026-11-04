"""Build the Claude flower: render the sprite atlas, package it for Codex, and write preview media into out/.

Usage: python3 build.py [--install]   (needs bun and Pillow; DejaVu font for showcase labels)
--install also copies the package into Codex's companion dir (~/.codex/pets/claude-flower/, Codex's naming).
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CW, CH = 192, 208
BG = (245, 243, 238)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Atlas rows and frame timings from the Codex v2 sprite contract; None = the 16-cell look loop in rows 9-10.
ROWS = {
    "idle": (0, [280, 110, 110, 140, 140, 320]),
    "running-right": (1, [120] * 7 + [220]),
    "running-left": (2, [120] * 7 + [220]),
    "waving": (3, [140] * 3 + [280]),
    "jumping": (4, [140] * 4 + [280]),
    "failed": (5, [140] * 7 + [240]),
    "waiting": (6, [150] * 5 + [260]),
    "running": (7, [120] * 5 + [220]),
    "review": (8, [150] * 5 + [280]),
    "look-loop": (None, [90] * 16),
}
# Showcase order: (label, row key, loops); failed holds its wilted last frame for a beat.
SHOWCASE = [
    ("idle", "idle", 2), ("waving", "waving", 3), ("jumping", "jumping", 2), ("working", "running", 3),
    ("review", "review", 2), ("waiting", "waiting", 2), ("failed", "failed", 1),
    ("walking right", "running-right", 2), ("walking left", "running-left", 2), ("looking around", "look-loop", 2),
]
MANIFEST = {
    "id": "claude-flower",
    "displayName": "Claude",
    "description": "Theia Vogel's CC0 cartoon Claude: a wobbly terracotta flower with a sticker face, drawn procedurally in JS.",
    "spriteVersionNumber": 2,
    "spritesheetPath": "spritesheet.webp",
}


def cell(atlas, key, i, scale=1):
    """Return frame i of a row on the showcase background, optionally upscaled."""
    row, _ = ROWS[key]
    r, c = (row, i) if row is not None else (9 + i // 8, i % 8)
    sprite = atlas.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH))
    if scale != 1:
        sprite = sprite.resize((CW * scale, CH * scale), Image.LANCZOS)
    frame = Image.new("RGBA", sprite.size, BG + (255,))
    frame.alpha_composite(sprite)
    return frame


def main():
    # Render the raw atlas with the JS drawer; it is the single source of all pixels.
    OUT.mkdir(exist_ok=True)
    png = OUT / "atlas.png"
    subprocess.run(["bun", str(HERE / "draw.js"), str(png)], check=True)
    atlas = Image.open(png).convert("RGBA")

    # Package: lossless webp + v2 manifest; Codex requires the manifest filename pet.json.
    pkg = OUT / "codex"
    pkg.mkdir(exist_ok=True)
    atlas.save(pkg / "spritesheet.webp", lossless=True, quality=100)
    (pkg / "pet.json").write_text(json.dumps(MANIFEST, indent=2) + "\n")

    # Per-state preview GIFs at native size.
    previews = OUT / "previews"
    previews.mkdir(exist_ok=True)
    for key, (_, durs) in ROWS.items():
        frames = [cell(atlas, key, i).convert("RGB") for i in range(len(durs))]
        frames[0].save(previews / f"{key}.gif", save_all=True, append_images=frames[1:], duration=durs, loop=0)

    # Labeled 2x showcase GIF that plays every state in sequence.
    font = ImageFont.truetype(FONT, 26)
    frames, durs = [], []
    for label, key, loops in SHOWCASE:
        row_durs = list(ROWS[key][1])
        if key == "failed":
            row_durs[-1] = 1000
        for _ in range(loops):
            for i, d in enumerate(row_durs):
                f = Image.new("RGBA", (CW * 2, CH * 2 + 44), BG + (255,))
                f.alpha_composite(cell(atlas, key, i, 2))
                ImageDraw.Draw(f).text((CW, CH * 2 + 18), label, fill=(40, 40, 40), font=font, anchor="mm")
                frames.append(f.convert("RGB"))
                durs.append(d)
    frames[0].save(OUT / "showcase.gif", save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True)

    # Optional install into the local Codex companion dir.
    if "--install" in sys.argv:
        dest = Path.home() / ".codex/pets/claude-flower"
        shutil.copytree(pkg, dest, dirs_exist_ok=True)
        print(f"installed -> {dest}")
    print(f"built -> {OUT}")


if __name__ == "__main__":
    main()
