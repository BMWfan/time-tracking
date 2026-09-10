"""Spiegelt den Stand des Repositorys in einen lokal geladenen Ordner.

Nützlich, solange die Erweiterung entpackt geladen ist: kopieren, im Browser
neu laden, fertig. Name und Symbol bleiben unangetastet — die stehen in den
Einstellungen der Erweiterung und überleben deshalb jedes Update.

    python scripts/sync-local.py "C:/Pfad/zum/geladenen/Ordner"
"""

import argparse
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent

FILES = ["manifest.json", "panel.html", "src/background.js", "src/panel.js",
         "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", help="Ordner, aus dem der Browser die Erweiterung lädt")
    args = parser.parse_args()

    target = pathlib.Path(args.target)
    if not target.is_dir():
        raise SystemExit(f"Kein Ordner: {target}")

    for rel in FILES:
        dst = target / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)

    print(f"{len(FILES)} Dateien nach {target}")
    print("Im Browser noch neu laden.")


if __name__ == "__main__":
    main()
