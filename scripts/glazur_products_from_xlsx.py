#!/usr/bin/env python3
"""
Build Shopify product import CSV + extract hero images from Glazur zips.

Input (defaults — override with env or first args):
  GLAZUR_XLSX, GLAZUR_ZIP_CUTOUT, GLAZUR_ZIP_MODELS

Output (under repo root):
  exports/glazur-products-shopify.csv
  exports/glazur-product-images/<handle>.jpg   (one hero per SKU)

After run:
  1) Shopify Admin → Products → Import → upload CSV (UTF-8).
  2) Online Store → Collections → create 3 manual collections (handles blouses, stripes, skirts),
     add products by tag OR use smart collections (tag = category-blouses, etc.).
  3) Theme settings → assign those collections to Blouses / Parisian stripe tops / Skirts.
  4) Optional: add more images per product in Admin; hero file is in exports/glazur-product-images/.
"""

from __future__ import annotations

import csv
import html
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "exports"
IMG_OUT = OUT_DIR / "glazur-product-images"
CSV_PATH = OUT_DIR / "glazur-products-shopify.csv"

DEFAULT_XLSX = Path.home() / "Downloads" / "Список товаров.xlsx"
DEFAULT_ZIP_CUT = Path.home() / "Downloads" / "Товары в обтравке-20260414T171338Z-3-001.zip"
DEFAULT_ZIP_MOD = Path.home() / "Downloads" / "Товары на моделях-20260414T171340Z-3-001.zip"

# Filename inside cutout zip (prefix folder stripped) per SKU — adjust if your pack changes.
CUTOUT_BY_SKU: dict[str, str] = {
    "GLZ-SS26-BL01-SI": "IMG_8406.JPG",
    "GLZ-SS26-BL02-IN": "Глазурь Блузка голубая.jpg",
    "GLZ-SS26-BL03-BL": "Блузка Глазурь голубая 2.jpg",
    "GLZ-SS26-SK01-LU": "Юбка белая.jpg",
    "GLZ-SS26-ST01-DB": "красная тельняшка лого_resized (1).jpg",
    "GLZ-SS26-ST02-WI": "Тельняшка фиолетовая цвет норм.jpg",
    "GLZ-SS26-ST03-CR": "IMG_8409.JPG",
    "GLZ-SS26-ST04-MP": "ЧБ тельняшка лого (1).jpg",
}


def category_from_sku(sku: str) -> tuple[str, str]:
    """(tag for smart collection, human type)."""
    if "-BL" in sku or sku.endswith("BL") or "BL0" in sku:
        return "category-blouses", "Blouse"
    if "-SK" in sku or "SK0" in sku:
        return "category-skirts", "Skirt"
    if "-ST" in sku or "ST0" in sku:
        return "category-stripes", "Stripe top"
    return "category-glazur", "Apparel"


def parse_xlsx_rows(path: Path) -> list[dict]:
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(path) as z:
        shared = ET.fromstring(z.read("xl/sharedStrings.xml"))
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        strings: list[str] = []
        for si in shared.findall(".//m:si", ns):
            parts = [t.text or "" for t in si.findall(".//m:t", ns)]
            strings.append("".join(parts))

        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        rows: list[list[str]] = []
        for row in sheet.findall(".//m:row", ns):
            r: list[str] = []
            for c in row.findall("m:c", ns):
                t = c.get("t")
                v = c.find("m:v", ns)
                if v is None or v.text is None:
                    r.append("")
                    continue
                if t == "s":
                    r.append(strings[int(v.text)])
                else:
                    r.append(v.text)
            if any((x or "").strip() for x in r):
                rows.append(r)
    if not rows:
        return []
    header = [h.strip() for h in rows[0]]
    idx = {name: header.index(name) for name in header if name in header}
    out: list[dict] = []
    for raw in rows[1:]:
        if len(raw) < len(header):
            raw = raw + [""] * (len(header) - len(raw))
        row = dict(zip(header, raw))
        sku = (row.get("Артикул") or "").strip()
        if not sku or not sku.startswith("GLZ"):
            continue
        out.append(row)
    return out


def body_html(description: str, composition: str, size: str, measurements: str) -> str:
    parts = []
    if composition:
        parts.append(f"<p><strong>Fabric</strong><br>{html.escape(composition)}</p>")
    if size:
        parts.append(f"<p><strong>Size</strong><br>{html.escape(size)}</p>")
    if measurements:
        m = html.escape(measurements).replace("\n", "<br>\n")
        parts.append(f"<p><strong>Measurements</strong><br>{m}</p>")
    if description:
        blocks = re.split(r"\n\s*\n", description.strip())
        for b in blocks:
            b = b.strip()
            if not b:
                continue
            label = None
            rest = b
            if "\n" in b:
                first, _, rest2 = b.partition("\n")
                if len(first) < 40 and not first.endswith("."):
                    label, rest = first.strip(), rest2.strip()
            inner = html.escape(rest).replace("\n", "<br>\n")
            if label:
                parts.append(f"<p><strong>{html.escape(label)}</strong><br>{inner}</p>")
            else:
                parts.append(f"<p>{inner}</p>")
    return "\n".join(parts) if parts else "<p></p>"


def find_in_zip(z: zipfile.ZipFile, suffix: str) -> str | None:
    for name in z.namelist():
        if name.endswith("/" + suffix) or name.endswith(suffix):
            return name
    return None


def extract_hero(zpath: Path, sku: str, dest_name: str) -> bool:
    suffix = CUTOUT_BY_SKU.get(sku)
    if not suffix or not zpath.exists():
        return False
    with zipfile.ZipFile(zpath) as z:
        key = find_in_zip(z, suffix)
        if not key:
            return False
        data = z.read(key)
        IMG_OUT.mkdir(parents=True, exist_ok=True)
        (IMG_OUT / dest_name).write_bytes(data)
        return True


def main() -> None:
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        __import__("os").environ.get("GLAZUR_XLSX", str(DEFAULT_XLSX))
    )
    z_cut = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(
        __import__("os").environ.get("GLAZUR_ZIP_CUTOUT", str(DEFAULT_ZIP_CUT))
    )

    if not xlsx.exists():
        print("Missing xlsx:", xlsx, file=sys.stderr)
        sys.exit(1)

    rows = parse_xlsx_rows(xlsx)
    if not rows:
        print("No product rows found.", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    IMG_OUT.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "Handle",
        "Title",
        "Body (HTML)",
        "Vendor",
        "Type",
        "Tags",
        "Published",
        "Option1 Name",
        "Option1 Value",
        "Variant SKU",
        "Variant Inventory Tracker",
        "Variant Inventory Qty",
        "Variant Inventory Policy",
        "Variant Fulfillment Service",
        "Variant Price",
        "Variant Requires Shipping",
        "Variant Taxable",
    ]

    with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for row in rows:
            title = (row.get("Название") or "").strip()
            sku = (row.get("Артикул") or "").strip()
            price = (row.get("Цена $") or "").strip()
            qty = (row.get("Количество") or "0").strip()
            try:
                qty_int = str(int(float(qty.replace(",", "."))))
            except ValueError:
                qty_int = "0"
            # SKU-based handle avoids collisions and matches inventory sheets
            handle = re.sub(r"[^a-z0-9-]", "", sku.lower())
            cat_tag, ptype = category_from_sku(sku)
            tags = f"glazur-ss26, {cat_tag}, import-xlsx"
            body = body_html(
                row.get("Описание") or "",
                row.get("Состав") or "",
                row.get("Размер") or "",
                row.get("Замеры (дюймы)") or "",
            )
            w.writerow(
                {
                    "Handle": handle,
                    "Title": title,
                    "Body (HTML)": body,
                    "Vendor": "Glazur",
                    "Type": ptype,
                    "Tags": tags,
                    "Published": "TRUE",
                    "Option1 Name": "Title",
                    "Option1 Value": "Default Title",
                    "Variant SKU": sku,
                    "Variant Inventory Tracker": "shopify",
                    "Variant Inventory Qty": qty_int,
                    "Variant Inventory Policy": "deny",
                    "Variant Fulfillment Service": "manual",
                    "Variant Price": price or "0",
                    "Variant Requires Shipping": "TRUE",
                    "Variant Taxable": "TRUE",
                }
            )
            ext = extract_hero(z_cut, sku, f"{handle}.jpg")
            if not ext:
                print("warn: no cutout image for", sku, file=sys.stderr)

    print("Wrote", CSV_PATH)
    print("Images →", IMG_OUT)
    print()
    print("Collections (choose one approach):")
    print("  A) Smart: tag = category-blouses | category-stripes | category-skirts")
    print("  B) Manual: create handles blouses, stripes, skirts and add products.")
    print("Then Theme settings → Catalog collections → map Blouses / Stripes / Skirts.")


if __name__ == "__main__":
    main()
