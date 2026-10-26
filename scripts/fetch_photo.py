#!/usr/bin/env python3
"""Download the main photo of a recipe and save it in the house format.

Usage: fetch_photo.py URL OUT.jpg

URL is either a recipe page (the photo is found in the page's recipe data,
or its og:image / twitter:image) or a link to the image itself. The photo
is saved as a JPEG of at most 1600 px on its longest side and under 1 MB,
the way tools/cooklint.py expects. Prints the photo's address on success.
Exit code 1 when no photo could be found or downloaded.
"""
import html
import io
import json
import re
import sys
import urllib.request
from urllib.parse import urljoin

from PIL import Image, ImageOps

MAX_SIDE = 1600
MAX_BYTES = 1024 * 1024
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8",
    "Accept-Language": "en,nl;q=0.8",
}


def get(url: str) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read(), res.headers.get("Content-Type", "")


def image_urls(value) -> list[str]:
    """The image field of schema.org data: a URL, a list, or an ImageObject."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [u for v in value for u in image_urls(v)]
    if isinstance(value, dict):
        u = value.get("url") or value.get("contentUrl")
        return [u] if u else []
    return []


def recipe_nodes(data):
    """Yields every node of type Recipe in JSON-LD, including inside @graph."""
    if isinstance(data, list):
        for d in data:
            yield from recipe_nodes(d)
    elif isinstance(data, dict):
        t = data.get("@type")
        if t == "Recipe" or (isinstance(t, list) and "Recipe" in t):
            yield data
        for key in ("@graph", "mainEntity"):
            if key in data:
                yield from recipe_nodes(data[key])


def photos_in_page(page: str) -> list[str]:
    """Candidate photo addresses: the recipe data first, then the share image."""
    found = []
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            data = json.loads(html.unescape(block.strip()))
        except ValueError:
            continue
        for node in recipe_nodes(data):
            found += image_urls(node.get("image"))
    for prop in ("og:image", "twitter:image"):
        m = re.search(rf'<meta[^>]+(?:property|name)=["\']{prop}["\'][^>]*content=["\']([^"\']+)', page, re.I) \
            or re.search(rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']{prop}["\']', page, re.I)
        if m:
            found.append(html.unescape(m.group(1)))
    # Sites often add a resize to the address; without it is the original.
    out = []
    for u in found:
        bare = re.sub(r'\?.*$', '', u) if re.search(r'[?&](resize|fit|w|h|width|height)=', u) else None
        for c in (bare, u):
            if c and c not in out:
                out.append(c)
    return out


def biggest(urls: list[str]) -> tuple[bytes, str] | None:
    """Downloads candidates and keeps the largest, stopping at a big enough one."""
    best = None
    for url in urls[:8]:
        try:
            data, ctype = get(url)
            with Image.open(io.BytesIO(data)) as im:
                area = im.width * im.height
                wide = max(im.size) >= 1200
        except Exception:
            continue
        if not best or area > best[0]:
            best = (area, data, url)
        if wide:
            break
    return (best[1], best[2]) if best else None


def save_jpeg(data: bytes, out: str) -> None:
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        for quality in (85, 78, 70, 60):
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
            if buf.tell() <= MAX_BYTES:
                break
    with open(out, "wb") as f:
        f.write(buf.getvalue())


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    url, out = sys.argv[1], sys.argv[2]
    try:
        data, ctype = get(url)
        if not ctype.startswith("image/"):
            photos = [urljoin(url, p) for p in photos_in_page(data.decode("utf-8", errors="replace"))]
            got = biggest(photos)
            if not got:
                print("No photo found on that page.", file=sys.stderr)
                return 1
            data, url = got
        save_jpeg(data, out)
    except Exception as exc:  # report and let the caller fall back to a pasted photo
        print(f"Could not get the photo: {exc}", file=sys.stderr)
        return 1
    print(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
