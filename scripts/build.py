"""Fabrique les paquets de la bibliothèque et son index.

Pour chaque dossier plugins/<id>/ : un paquet dist/<id>-<version>.json (les fichiers du plugin,
les binaires en base64) et une entrée dans index.json (manifeste résumé, taille, SHA-256,
adresse). Horizon lit index.json, télécharge le paquet, vérifie taille et empreinte, puis
écrit les fichiers.

    python scripts/build.py          # écrit dist/ et index.json
    python scripts/build.py --check  # échoue si index.json ou dist/ ne sont pas à jour
"""

import base64
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://raw.githubusercontent.com/KingsRequin/horizon-plugins/main/"
TEXT = {"plugin.json", "main.js", "README.md", "LICENSE", "PLUGINS.md"}


def wanted(rel: str) -> bool:
    return rel in TEXT or rel.endswith(".slint") or rel.startswith("assets/")


def bundle(folder: Path) -> tuple[dict, bytes]:
    manifest = json.loads((folder / "plugin.json").read_text(encoding="utf-8"))
    if manifest.get("id") != folder.name:
        raise SystemExit(f"{folder.name} : l'id de plugin.json doit être le nom du dossier")
    files = {}
    for f in sorted(folder.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(folder).as_posix()
        if not wanted(rel):
            continue
        if rel in TEXT or rel.endswith(".slint"):
            files[rel] = f.read_text(encoding="utf-8")
        else:
            files[rel] = "base64:" + base64.b64encode(f.read_bytes()).decode("ascii")
    data = json.dumps({"id": folder.name, "version": manifest["version"], "files": files}, ensure_ascii=False, indent=1).encode("utf-8")
    return manifest, data


def build() -> tuple[dict, dict]:
    outputs = {}
    plugins = []
    for folder in sorted((ROOT / "plugins").iterdir()):
        if not folder.is_dir():
            continue
        m, data = bundle(folder)
        name = f"dist/{folder.name}-{m['version']}.json"
        outputs[name] = data
        plugins.append(
            {
                "id": m["id"],
                "name": m["name"],
                "version": m["version"],
                "api": m["api"],
                "author": m.get("author"),
                "description": m.get("description"),
                "icon": m.get("icon"),
                "permissions": m.get("permissions", {}),
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "url": BASE + name,
            }
        )
    index = json.dumps({"version": 1, "plugins": plugins}, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    outputs["index.json"] = index
    return outputs, {p["id"]: p["version"] for p in plugins}


def main() -> None:
    outputs, versions = build()
    if "--check" in sys.argv:
        stale = [n for n, d in outputs.items() if not (ROOT / n).exists() or (ROOT / n).read_bytes() != d]
        if stale:
            raise SystemExit("à refaire (python scripts/build.py) : " + ", ".join(stale))
        print("index et paquets à jour")
        return
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    keep = {n for n in outputs if n.startswith("dist/")}
    for old in dist.glob("*.json"):
        if f"dist/{old.name}" not in keep:
            old.unlink()
    for name, data in outputs.items():
        (ROOT / name).write_bytes(data)
    for pid, v in versions.items():
        print(f"{pid} {v}")


if __name__ == "__main__":
    main()
