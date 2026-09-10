"""Erzeugt die Standardsymbole der Erweiterung ohne Bildbibliothek.

    python scripts/generate-icons.py

Gezeichnet wird ein abgerundetes Quadrat mit einer Uhr — neutral und ohne
Bezug zu einer fremden Marke. Wer ein eigenes Symbol will, hinterlegt es in
den Einstellungen der Erweiterung; das überlebt Updates, weil es im
Browser-Speicher liegt und nicht in diesen Dateien.
"""

import math
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (37, 99, 235)      # neutrales Blau
FG = (255, 255, 255)

U = 32.0                # Entwurfseinheiten
R_CORNER = 7.0          # Eckenradius
DIAL_R = 10.0           # Radius des Zifferblatts
RING = 2.4              # Strichstärke des Rings
HAND = 2.0              # Strichstärke der Zeiger
SS = 4                  # Supersampling je Achse


def covered(ux, uy):
    """Liefert (im_quadrat, ist_vordergrund) für einen Punkt in 32er-Einheiten."""
    if not (0 <= ux <= U and 0 <= uy <= U):
        return False, False

    dx = max(R_CORNER - ux, 0.0, ux - (U - R_CORNER))
    dy = max(R_CORNER - uy, 0.0, uy - (U - R_CORNER))
    if math.hypot(dx, dy) > R_CORNER:
        return False, False

    cx = cy = U / 2
    px, py = ux - cx, uy - cy
    if abs(math.hypot(px, py) - DIAL_R) <= RING / 2:
        return True, True

    def near_segment(bx, by):
        length2 = bx * bx + by * by
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, (px * bx + py * by) / length2))
        return math.hypot(px - t * bx, py - t * by) <= HAND / 2

    # Zeiger auf 12 und auf 4 Uhr
    if near_segment(0.0, -DIAL_R * 0.62) or near_segment(DIAL_R * 0.5, DIAL_R * 0.3):
        return True, True

    return True, False


def render(size):
    scale = U / size
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            inside = fg = 0
            for sy in range(SS):
                for sx in range(SS):
                    ux = (px + (sx + 0.5) / SS) * scale
                    uy = (py + (sy + 0.5) / SS) * scale
                    in_square, is_fg = covered(ux, uy)
                    inside += in_square
                    fg += is_fg
            total = SS * SS
            if not inside:
                row += bytes((0, 0, 0, 0))
                continue
            # Vordergrundanteil über den Hintergrund mischen
            mix = fg / inside
            colour = tuple(round(BG[i] + (FG[i] - BG[i]) * mix) for i in range(3))
            row += bytes(colour + (round(255 * inside / total),))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    for size in (16, 32, 48, 128):
        blob = render(size)
        (OUT / f"{size}.png").write_bytes(blob)
        print(size, len(blob))
