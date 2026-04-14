#!/usr/bin/env python3
"""
Create Glazur storefront pages (care, faq, size-guide, shipping-returns) if they
do not exist yet. Theme fills body from snippets when handle matches.

Requires a Custom App (or legacy private app) with Admin API scope:
  read_content, write_content

Usage:
  export SHOPIFY_STORE="your-shop.myshopify.com"   # not the custom domain
  export SHOPIFY_ACCESS_TOKEN="shpat_...."
  python3 scripts/create_glazur_shopify_pages.py

Optional: SHOPIFY_API_VERSION=2024-10
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request

API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2024-10").strip()
STORE = os.environ.get("SHOPIFY_STORE", "").strip()
TOKEN = os.environ.get("SHOPIFY_ACCESS_TOKEN", "").strip()

PAGES: list[tuple[str, str, str]] = [
    ("care", "Garment care", ""),
    ("faq", "FAQ", ""),
    ("size-guide", "Size guide", ""),
    ("shipping-returns", "Delivery & returns", ""),
]


def admin_url(path: str) -> str:
    host = STORE.replace("https://", "").replace("http://", "").strip("/")
    if not host.endswith(".myshopify.com"):
        print(
            "Error: SHOPIFY_STORE must be the myshopify.com hostname, e.g. glazurshop.myshopify.com",
            file=sys.stderr,
        )
        sys.exit(1)
    return f"https://{host}/admin/api/{API_VERSION}/{path.lstrip('/')}"


def api_request(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    url = admin_url(path)
    data = None
    headers = {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(err)
        except json.JSONDecodeError:
            parsed = {"raw": err}
        return e.code, parsed


def page_exists(handle: str) -> bool:
    status, data = api_request("GET", f"pages.json?handle={handle}")
    if status != 200:
        print(f"GET pages?handle={handle} -> {status}: {data}", file=sys.stderr)
        sys.exit(1)
    pages = data.get("pages") or []
    return len(pages) > 0


def create_page(handle: str, title: str, body_html: str) -> None:
    payload = {
        "page": {
            "title": title,
            "handle": handle,
            "body_html": body_html or "<p></p>",
            "published": True,
        }
    }
    status, data = api_request("POST", "pages.json", payload)
    if status in (200, 201):
        page = data.get("page") or {}
        print(f"OK created: {page.get('handle')} -> {page.get('admin_graphql_api_id', page.get('id'))}")
        return
    if status == 422:
        print(f"SKIP or fix {handle}: {data}", file=sys.stderr)
        return
    print(f"FAIL POST {handle} ({status}): {data}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if not STORE or not TOKEN:
        print(
            "Set SHOPIFY_STORE (e.g. glazurshop.myshopify.com) and SHOPIFY_ACCESS_TOKEN.",
            file=sys.stderr,
        )
        sys.exit(1)

    for handle, title, body in PAGES:
        if page_exists(handle):
            print(f"exists: {handle}")
            continue
        print(f"creating: {handle} …")
        create_page(handle, title, body)

    print("Done. Open each URL on the storefront to confirm (theme must be deployed with main-page snippets).")


if __name__ == "__main__":
    main()
