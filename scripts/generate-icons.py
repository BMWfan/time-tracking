import struct, zlib, math, pathlib

OUT = pathlib.Path(r"C:\Users\danie\OneDrive\Documents\protime-extension\icons")
OUT.mkdir(parents=True, exist_ok=True)

PINK = (242, 21, 87)

# Geometrie in der Einheit des Originals (33 x 33), aus dem Logo ausgemessen:
# pinkes Quadrat mit drei Aussparungen (Querbalken, rechter Balken, Kreis).
U = 33.0
R_CORNER = 1.6
BAR_TOP = (5.0, 6.0, 23.0, 7.0)     # x, y, w, h
BAR_RIGHT = (20.0, 13.0, 8.0, 15.0)
CIRCLE = (10.5, 22.5, 5.5)          # cx, cy, r

SS = 4  # Supersampling je Achse


def covered(ux, uy):
    """True, wenn der Punkt (in 33er-Einheiten) pink ist."""
    # abgerundetes Quadrat
    if not (0 <= ux <= U and 0 <= uy <= U):
        return False
    dx = max(R_CORNER - ux, 0.0, ux - (U - R_CORNER))
    dy = max(R_CORNER - uy, 0.0, uy - (U - R_CORNER))
    if math.hypot(dx, dy) > R_CORNER:
        return False

    for bx, by, bw, bh in (BAR_TOP, BAR_RIGHT):
        if bx <= ux < bx + bw and by <= uy < by + bh:
            return False

    cx, cy, r = CIRCLE
    if math.hypot(ux - cx, uy - cy) <= r:
        return False

    return True


def render(size):
    scale = U / size
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    ux = (px + (sx + 0.5) / SS) * scale
                    uy = (py + (sy + 0.5) / SS) * scale
                    if covered(ux, uy):
                        hits += 1
            alpha = round(255 * hits / (SS * SS))
            row += bytes(PINK + (alpha,))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


for s in (16, 32, 48, 128):
    blob = render(s)
    (OUT / f"{s}.png").write_bytes(blob)
    print(s, len(blob))
