#!/usr/bin/env python3
"""Local preview of the recipe site at http://localhost:8000

Reads the recipes straight from your synced Google Drive folder and serves the
website from app/, so:
  * a change to app/ (HTML, CSS, JS) shows after a browser refresh
  * a change to a recipe in Drive shows after a browser refresh

Settings live in local.json next to this repo's README (created on first run,
not committed):
  recipesDir  path to the synced "Cooklang Recipes" folder
  clientId    Google sign-in client ID (optional, enables "Sign in" locally)
  folderId    Google Drive folder ID (needed for signing in)
  authUrl     address of the recipes Worker (optional, keeps you signed in)
  title       site title

The tests start their own copy on the fixture recipes with RECIPES_DIR,
DEV_OUT (where the data is built) and PORT; then local.json is not needed.
"""
import json
import os
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
OUT = Path(os.environ.get("DEV_OUT") or ROOT / ".dev" / "site")
SETTINGS = ROOT / "local.json"
PORT = int(os.environ.get("PORT", "8000"))

sys.path.insert(0, str(ROOT / "scripts"))
import build as builder  # noqa: E402


def load_settings() -> dict:
    if os.environ.get("RECIPES_DIR"):
        return {"recipesDir": os.environ["RECIPES_DIR"], "title": "Recipes"}
    if not SETTINGS.exists():
        default = {
            "recipesDir": str(Path.home() / "My Drive" / "Cooklang Recipes"),
            "clientId": "",
            "folderId": "",
            "title": "Jens's Recipes",
        }
        SETTINGS.write_text(json.dumps(default, indent=2), encoding="utf-8")
        print(f"Created {SETTINGS.name}. Check that recipesDir points to your recipe folder.")
    return json.loads(SETTINGS.read_text(encoding="utf-8"))


settings = load_settings()
recipes_dir = Path(settings["recipesDir"]).expanduser()
if not recipes_dir.is_dir():
    sys.exit(f"Recipe folder not found: {recipes_dir}\nFix recipesDir in {SETTINGS}")

os.environ["SITE_TITLE"] = settings.get("title") or "Recipes"
os.environ["GOOGLE_CLIENT_ID"] = settings.get("clientId", "")
os.environ["AUTH_URL"] = settings.get("authUrl", "")
os.environ["GDRIVE_FOLDER_ID"] = settings.get("folderId", "")

lock = threading.Lock()
last_stamp = None


def stamp() -> frozenset:
    """Changes whenever a recipe, photo or aisle.conf is added, removed, renamed, moved or edited."""
    kinds = (".cook", ".jpg", ".jpeg", ".png", ".webp", ".conf")
    return frozenset(
        (p.relative_to(recipes_dir).as_posix(), st.st_size, st.st_mtime_ns)
        for p in recipes_dir.rglob("*") if p.suffix.lower() in kinds
        for st in (p.stat(),)
    )


def rebuild_if_needed() -> None:
    global last_stamp
    with lock:
        now = stamp()
        if now != last_stamp:
            builder.build(recipes_dir, APP, OUT, keep_photos=True)
            last_stamp = now


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith(("/data/", "/img/", "/thumb/")) or clean == "/manifest.webmanifest":
            if clean.startswith("/data/"):
                rebuild_if_needed()
            return super().translate_path(path).replace(str(APP), str(OUT), 1)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


# The site asks for its modules, styles and fonts all at once; the default
# queue of 5 waiting connections turns some of them away on Windows.
ThreadingHTTPServer.request_queue_size = 128

Handler.extensions_map[".wasm"] = "application/wasm"
Handler.extensions_map[".js"] = "text/javascript"
Handler.extensions_map[".webmanifest"] = "application/manifest+json"

if __name__ == "__main__":
    print(f"Reading recipes from {recipes_dir}")
    rebuild_if_needed()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(APP)))
    print(f"Recipe site running at http://localhost:{PORT}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
