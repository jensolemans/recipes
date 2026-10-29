#!/usr/bin/env python3
"""Build the public recipe site.

Usage: build.py RECIPES_DIR APP_DIR OUT_DIR

Copies the web app from APP_DIR to OUT_DIR (naming the home-screen app in
manifest.webmanifest after the site title) and writes:
  data/recipes.json  every .cook file: path, source text, md5, modified time, image
  img/<id>.jpg       full-size photo (max 1600 px)
  thumb/<id>.jpg     card thumbnail (max 640 px)

The md5 matches Google Drive's md5Checksum, so the signed-in editor can tell
which files changed in Drive after this build.
"""
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

from PIL import Image, ImageOps

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
FULL_MAX = 1600
THUMB_MAX = 640


def image_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:16]


def save_resized(src: Path, dest: Path, max_side: int, quality: int) -> None:
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return  # already up to date (local preview keeps its photos between runs)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((max_side, max_side), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        dest.parent.mkdir(parents=True, exist_ok=True)
        im.save(dest, "JPEG", quality=quality, optimize=True, progressive=True)


def find_image(cook: Path) -> Path | None:
    for ext in IMAGE_EXTS:
        for cand in (cook.with_suffix(ext), cook.with_suffix(ext.upper())):
            if cand.exists():
                return cand
    return None


def stamp_service_worker(app_dir: Path, out_dir: Path) -> None:
    """Names the offline cache after a fingerprint of the site files.

    A change to the site then changes sw.js, so phones install the whole new
    version at once instead of picking it up file by file. Recipe changes do
    not count: the recipe index refreshes on its own.
    """
    sw = out_dir / "sw.js"
    if not sw.exists():
        return
    digest = hashlib.sha1()
    for f in sorted(p for p in app_dir.rglob("*") if p.is_file()):
        digest.update(f.relative_to(app_dir).as_posix().encode("utf-8"))
        digest.update(f.read_bytes().replace(b"\r\n", b"\n"))
    text = sw.read_text(encoding="utf-8")
    sw.write_text(text.replace("const CACHE = 'recipes-dev';", f"const CACHE = 'recipes-{digest.hexdigest()[:10]}';"), encoding="utf-8")


def build(recipes_dir: Path, app_dir: Path, out_dir: Path, keep_photos: bool = False) -> int:
    if out_dir.exists():
        for child in out_dir.iterdir():
            if keep_photos and child.name in ("img", "thumb"):
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(app_dir, out_dir, dirs_exist_ok=True)
    stamp_service_worker(app_dir, out_dir)

    recipes = []
    for cook in sorted(recipes_dir.rglob("*.cook")):
        rel = cook.relative_to(recipes_dir).with_suffix("").as_posix()
        if any(part.startswith(".") for part in rel.split("/")):
            continue
        raw = cook.read_bytes()
        entry = {
            "path": rel,
            "src": raw.decode("utf-8", errors="replace"),
            "md5": hashlib.md5(raw).hexdigest(),
            "modified": int(cook.stat().st_mtime),
        }
        img = find_image(cook)
        if img is not None:
            iid = image_id(rel)
            try:
                save_resized(img, out_dir / "img" / f"{iid}.jpg", FULL_MAX, 82)
                save_resized(img, out_dir / "thumb" / f"{iid}.jpg", THUMB_MAX, 74)
                entry["image"] = iid
                entry["imageName"] = img.name
                entry["imageMd5"] = hashlib.md5(img.read_bytes()).hexdigest()
            except Exception as exc:  # a broken photo should not break the site
                print(f"warning: skipped image {img}: {exc}", file=sys.stderr)
        recipes.append(entry)

    skip_top = {"config", "tools"}
    folders = sorted(
        p.relative_to(recipes_dir).as_posix() for p in recipes_dir.rglob("*")
        if p.is_dir()
        and p.relative_to(recipes_dir).parts[0] not in skip_top
        and not any(s.startswith(".") for s in p.relative_to(recipes_dir).parts)
    )

    data_dir = out_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    config = {
        "title": os.environ.get("SITE_TITLE") or "Recipes",
        "clientId": os.environ.get("GOOGLE_CLIENT_ID", ""),
        "authUrl": os.environ.get("AUTH_URL", ""),
        "folderId": os.environ.get("GDRIVE_FOLDER_ID", ""),
        "publishUrl": f"https://github.com/{repo}/actions/workflows/publish.yml" if repo else "",
    }
    # The store order, so friends can sort a recipe's ingredients by aisle too.
    aisle_conf = recipes_dir / "config" / "aisle.conf"
    aisle = aisle_conf.read_text(encoding="utf-8") if aisle_conf.exists() else ""
    payload = {"built": int(time.time()), "config": config, "folders": folders, "recipes": recipes, "aisle": aisle}
    manifest_path = out_dir / "manifest.webmanifest"
    if manifest_path.exists():  # the home-screen app is named after the site
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["name"] = manifest["short_name"] = config["title"]
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (data_dir / "recipes.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"Built {len(recipes)} recipes, "
          f"{sum(1 for r in recipes if 'image' in r)} photos, {len(folders)} folders")
    if not recipes:
        print("error: no recipes found", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    recipes_dir, app_dir, out_dir = (Path(a).resolve() for a in sys.argv[1:4])
    return build(recipes_dir, app_dir, out_dir)


if __name__ == "__main__":
    sys.exit(main())
