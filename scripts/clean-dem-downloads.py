#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "data"
DEFAULT_INPUTS = (
    DEFAULT_OUTPUT_DIR / "oregon-dems.csv",
    DEFAULT_OUTPUT_DIR / "washington-dems.csv",
)

TILE_PATTERN = re.compile(r"\b(n\d{2}[ew]\d{3})\b", re.I)
TITLE_DATE_PATTERN = re.compile(r"(\d{8})\s*$")

# fixed positions in The National Map CSV export
TITLE_INDEX = 0
PUBLICATION_DATE_INDEX = 8
LAST_UPDATED_INDEX = 9
SIZE_BYTES_INDEX = 11
FORMAT_INDEX = 13
DOWNLOAD_URL_INDEX = 14
MINIMUM_COLUMNS = DOWNLOAD_URL_INDEX + 1

OUTPUT_FIELDS = (
    "tile",
    "product_date",
    "publication_date",
    "last_updated",
    "size_bytes",
    "size_mib",
    "download_url",
    "title",
    "source_csv",
)


@dataclass(frozen=True)
class DemProduct:
    tile: str
    product_date: date
    publication_date: date
    last_updated: str
    size_bytes: int
    download_url: str
    title: str
    source_csv: str

    @property
    def version_rank(self) -> tuple[date, date, str]:
        """orders products newest first using stable export fields"""
        return self.publication_date, self.product_date, self.last_updated


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Keep the newest USGS 3DEP product for each one-degree tile and "
            "write CSV and plain-URL download lists."
        )
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        help="USGS CSV exports; defaults to the Oregon and Washington files in data/",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="destination directory for cleaned lists (default: data/)",
    )
    parser.add_argument(
        "--combined-name",
        type=output_stem,
        default="or-wa-dems-latest",
        help="combined output filename without an extension",
    )
    parser.add_argument(
        "--verify-urls",
        action="store_true",
        help="check every selected GeoTIFF URL before finishing",
    )
    parser.add_argument(
        "--workers",
        type=positive_integer,
        default=8,
        help="parallel URL checks used with --verify-urls (default: 8)",
    )
    return parser.parse_args(argv)


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def output_stem(value: str) -> str:
    if not value or Path(value).name != value or Path(value).suffix:
        raise argparse.ArgumentTypeError("must be a filename without a path or extension")
    return value


def parse_product(row: list[str], source: Path, row_number: int) -> DemProduct:
    if len(row) < MINIMUM_COLUMNS:
        raise ValueError(
            f"{source}:{row_number}: expected at least {MINIMUM_COLUMNS} columns, "
            f"found {len(row)}"
        )

    title = row[TITLE_INDEX].strip()
    tile_match = TILE_PATTERN.search(title)
    if not tile_match:
        raise ValueError(f"{source}:{row_number}: no tile ID in title {title!r}")

    try:
        publication_date = date.fromisoformat(row[PUBLICATION_DATE_INDEX].strip())
    except ValueError as error:
        raise ValueError(
            f"{source}:{row_number}: invalid publication date "
            f"{row[PUBLICATION_DATE_INDEX]!r}"
        ) from error

    # some catalog titles omit the product date so publication date is the fallback
    title_date_match = TITLE_DATE_PATTERN.search(title)
    if title_date_match:
        product_date = parse_compact_date(title_date_match.group(1), source, row_number)
    else:
        product_date = publication_date

    download_url = row[DOWNLOAD_URL_INDEX].strip()
    if row[FORMAT_INDEX].strip().lower() != "geotiff" or not download_url.endswith(".tif"):
        raise ValueError(
            f"{source}:{row_number}: expected a GeoTIFF download URL, found "
            f"{download_url!r}"
        )

    try:
        size_bytes = int(row[SIZE_BYTES_INDEX])
    except ValueError as error:
        raise ValueError(
            f"{source}:{row_number}: invalid byte size {row[SIZE_BYTES_INDEX]!r}"
        ) from error

    return DemProduct(
        tile=tile_match.group(1).lower(),
        product_date=product_date,
        publication_date=publication_date,
        last_updated=row[LAST_UPDATED_INDEX].strip(),
        size_bytes=size_bytes,
        download_url=download_url,
        title=title,
        source_csv=source.name,
    )


def parse_compact_date(value: str, source: Path, row_number: int) -> date:
    try:
        return date(int(value[:4]), int(value[4:6]), int(value[6:8]))
    except ValueError as error:
        raise ValueError(
            f"{source}:{row_number}: invalid product date {value!r}"
        ) from error


def newest_products(source: Path) -> tuple[int, dict[str, DemProduct]]:
    latest: dict[str, DemProduct] = {}
    row_count = 0

    with source.open(newline="", encoding="utf-8-sig") as handle:
        for row_count, row in enumerate(csv.reader(handle), start=1):
            product = parse_product(row, source, row_count)
            current = latest.get(product.tile)
            if current is None or product.version_rank > current.version_rank:
                latest[product.tile] = product

    if row_count == 0:
        raise ValueError(f"{source}: CSV is empty")

    return row_count, latest


def write_outputs(
    output_dir: Path,
    stem: str,
    products: dict[str, DemProduct],
    sources_by_tile: dict[str, set[str]],
) -> tuple[Path, Path]:
    csv_path = output_dir / f"{stem}.csv"
    url_path = output_dir / f"{stem}-urls.txt"

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        for tile in sorted(products):
            product = products[tile]
            writer.writerow(
                {
                    "tile": tile,
                    "product_date": product.product_date.isoformat(),
                    "publication_date": product.publication_date.isoformat(),
                    "last_updated": product.last_updated,
                    "size_bytes": product.size_bytes,
                    "size_mib": f"{product.size_bytes / 1024 / 1024:.1f}",
                    "download_url": product.download_url,
                    "title": product.title,
                    "source_csv": ";".join(sorted(sources_by_tile[tile])),
                }
            )

    with url_path.open("w", encoding="utf-8", newline="\n") as handle:
        for tile in sorted(products):
            handle.write(products[tile].download_url + "\n")

    return csv_path, url_path


def verify_urls(products: dict[str, DemProduct], workers: int) -> None:
    failures: list[str] = []

    with ThreadPoolExecutor(max_workers=workers) as executor:
        checks = {
            executor.submit(check_url, product.download_url): tile
            for tile, product in products.items()
        }
        for future in as_completed(checks):
            tile = checks[future]
            try:
                future.result()
            except (HTTPError, URLError, TimeoutError) as error:
                failures.append(f"{tile}: {error}")

    if failures:
        details = "\n".join(sorted(failures))
        raise RuntimeError(f"{len(failures)} URL checks failed:\n{details}")


def check_url(url: str) -> None:
    request = Request(url, method="HEAD", headers={"User-Agent": "dem-list-cleaner/1.0"})
    with urlopen(request, timeout=30) as response:
        if response.status >= 400:
            raise HTTPError(url, response.status, response.reason, response.headers, None)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    inputs = tuple(path.resolve() for path in (args.inputs or DEFAULT_INPUTS))
    output_dir = args.output_dir.resolve()

    if len(inputs) != len(set(inputs)):
        raise ValueError("the same input CSV was provided more than once")

    per_input: list[tuple[Path, int, dict[str, DemProduct]]] = []
    combined: dict[str, DemProduct] = {}
    combined_sources: dict[str, set[str]] = {}

    # validate every export before replacing any existing cleaned lists
    for source in inputs:
        row_count, latest = newest_products(source)
        per_input.append((source, row_count, latest))

        for tile, product in latest.items():
            combined_sources.setdefault(tile, set()).add(source.name)
            current = combined.get(tile)
            if current is None or product.version_rank > current.version_rank:
                combined[tile] = product

    per_input_stems = [f"{source.stem}-latest" for source, _, _ in per_input]
    output_stems = per_input_stems + [args.combined_name]
    if len(output_stems) != len(set(output_stems)):
        raise ValueError("output names collide; rename inputs or use --combined-name")

    planned_outputs = {
        (output_dir / f"{stem}{suffix}").resolve()
        for stem in output_stems
        for suffix in (".csv", "-urls.txt")
    }
    if planned_outputs.intersection(inputs):
        raise ValueError("an output path would overwrite an input CSV")

    if args.verify_urls:
        verify_urls(combined, args.workers)

    output_dir.mkdir(parents=True, exist_ok=True)
    for (source, _, latest), stem in zip(per_input, per_input_stems):
        sources = {tile: {source.name} for tile in latest}
        write_outputs(output_dir, stem, latest, sources)

    write_outputs(output_dir, args.combined_name, combined, combined_sources)

    for source, row_count, latest in per_input:
        print(f"{source.name}: {row_count} rows -> {len(latest)} unique tiles")

    total_rows = sum(row_count for _, row_count, _ in per_input)
    total_gib = sum(product.size_bytes for product in combined.values()) / 1024**3
    print(
        f"{args.combined_name}: {total_rows} rows -> {len(combined)} unique tiles "
        f"({total_gib:.2f} GiB)"
    )
    if args.verify_urls:
        print(f"verified {len(combined)} download URLs")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
