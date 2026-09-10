"""Spiegelt den Stand in einen lokal geladenen Ordner und setzt dabei optional
einen eigenen Namen ins Manifest.

Der Name in der Erweiterungsliste des Browsers stammt aus ``manifest.json`` und
ist zur Laufzeit nicht änderbar. Wer ihn dort anders lesen will, patcht ihn beim
Spiegeln — im Repository bleibt der neutrale Name stehen.

    python scripts/sync-local.py "C:/Pfad/zum/geladenen/Ordner"
    python scripts/sync-local.py "C:/Pfad" --name "Mein Name"
"""

import argparse
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent

FILES = ["panel.html", "src/background.js", "src/panel.js",
         "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", help="Ordner, aus dem der Browser die Erweiterung lädt")
    parser.add_argument("--name", help="Name für manifest.json, sonst der aus dem Repository")
    args = parser.parse_args()

    target = pathlib.Path(args.target)
    if not target.is_dir():
        raise SystemExit(f"Kein Ordner: {target}")

    for rel in FILES:
        dst = target / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if args.name:
        manifest["name"] = args.name
        manifest["action"]["default_title"] = args.name
    (target / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(f"{len(FILES) + 1} Dateien nach {target}")
    print("Version:", manifest["version"])
    print("Name:   ", manifest["name"])
    print("Im Browser noch neu laden.")


if __name__ == "__main__":
    main()
