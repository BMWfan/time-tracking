"""Baut das Einreichungspaket für die Edge Add-ons.

Unterschied zum Repository-Stand: Das Feld ``key`` fliegt heraus. Es fixiert die
Erweiterungs-ID beim entpackten Laden, im Store vergibt aber der Store die ID —
bleibt ``key`` drin, wird das Paket abgelehnt.

    python scripts/build-store-package.py

Ergebnis: dist/time-tracking-store-v<version>.zip
"""

import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Nur was die Erweiterung zur Laufzeit braucht. Werkzeuge, Texte und
# Arbeitsabläufe gehören nicht ins Paket.
INCLUDE = [
    "manifest.json",
    "panel.html",
    "src/background.js",
    "src/panel.js",
    "icons/16.png",
    "icons/32.png",
    "icons/48.png",
    "icons/128.png",
]


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    manifest.pop("key", None)

    missing = [p for p in INCLUDE if not (ROOT / p).exists()]
    if missing:
        raise SystemExit("Fehlende Dateien: " + ", ".join(missing))

    DIST.mkdir(exist_ok=True)
    target = DIST / f"time-tracking-store-v{version}.zip"

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in INCLUDE:
            if path == "manifest.json":
                zf.writestr(path, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
            else:
                zf.write(ROOT / path, path)

    print(f"{target.relative_to(ROOT)}  ({target.stat().st_size / 1024:.1f} KB)")
    print("Version:", version)
    print("key entfernt:", "key" not in manifest)
    with zipfile.ZipFile(target) as zf:
        for info in zf.infolist():
            print(f"  {info.filename:24} {info.file_size:>7} Bytes")


if __name__ == "__main__":
    main()
