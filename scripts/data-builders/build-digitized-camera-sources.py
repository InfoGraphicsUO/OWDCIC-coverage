#!/usr/bin/env python3
"""convert the ArcGIS StatewideNetwork point shapefile to web-map GeoJSON, CSV, and XLSX"""

from __future__ import annotations

import argparse
import csv
import json
import zipfile
from xml.sax.saxutils import escape
import math
import struct
from collections import Counter
from pathlib import Path


# NAD83 / Oregon Statewide Lambert in international feet
SEMI_MAJOR_AXIS_METERS = 6_378_137.0
INVERSE_FLATTENING = 298.257222101
LATITUDE_OF_ORIGIN = 41.75
STANDARD_PARALLELS = (43.0, 45.5)
CENTRAL_MERIDIAN = -120.5
FALSE_EASTING_FEET = 1_312_335.958005249
METERS_PER_FOOT = 0.3048


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="StatewideNetwork.shp input")
    parser.add_argument("output", type=Path, help="GeoJSON output path")
    parser.add_argument(
        "--tabular",
        action="store_true",
        help="also write .csv and .xlsx next to the GeoJSON output",
    )
    return parser.parse_args()


def read_dbf(path: Path) -> list[dict[str, str]]:
    with path.open("rb") as stream:
        header = stream.read(32)
        record_count = struct.unpack("<I", header[4:8])[0]
        header_length = struct.unpack("<H", header[8:10])[0]
        record_length = struct.unpack("<H", header[10:12])[0]
        fields: list[tuple[str, int]] = []

        # dBase field descriptors end at the 0x0d header terminator
        while True:
            descriptor = stream.read(32)
            if not descriptor:
                raise ValueError(f"Unexpected end of DBF header: {path}")
            if descriptor[0] == 0x0D:
                break

            name = descriptor[:11].split(b"\0", 1)[0].decode("ascii")
            fields.append((name, descriptor[16]))

        stream.seek(header_length)
        rows = []
        for _ in range(record_count):
            record = stream.read(record_length)
            if len(record) != record_length:
                raise ValueError(f"Unexpected end of DBF records: {path}")
            if record[:1] == b"*":
                continue

            offset = 1
            row = {}
            for name, length in fields:
                raw_value = record[offset : offset + length]
                offset += length
                row[name] = (
                    raw_value.decode("cp1252", errors="replace")
                    .replace("\x00", "")
                    .strip()
                )
            rows.append(row)

    return rows


def read_point_z_shapes(path: Path) -> list[tuple[float, float]]:
    points = []

    with path.open("rb") as stream:
        header = stream.read(100)
        if len(header) != 100:
            raise ValueError(f"Invalid shapefile header: {path}")

        shape_type = struct.unpack("<i", header[32:36])[0]
        if shape_type != 11:
            raise ValueError(f"Expected PointZ shapefile type 11, found {shape_type}")

        # each record uses a big-endian wrapper around little-endian geometry
        while record_header := stream.read(8):
            if len(record_header) != 8:
                raise ValueError(f"Invalid shapefile record header: {path}")

            _, content_length_words = struct.unpack(">2i", record_header)
            content = stream.read(content_length_words * 2)
            if len(content) != content_length_words * 2:
                raise ValueError(f"Unexpected end of shapefile records: {path}")

            record_type = struct.unpack("<i", content[:4])[0]
            if record_type == 0:
                continue
            if record_type != 11:
                raise ValueError(f"Expected PointZ record type 11, found {record_type}")

            points.append(struct.unpack("<2d", content[4:20]))

    return points


def inverse_oregon_lambert(x_feet: float, y_feet: float) -> tuple[float, float]:
    # ellipsoid eccentricity used by the conformal latitude terms
    flattening = 1 / INVERSE_FLATTENING
    eccentricity = math.sqrt(2 * flattening - flattening * flattening)

    def m(latitude: float) -> float:
        return math.cos(latitude) / math.sqrt(
            1 - eccentricity * eccentricity * math.sin(latitude) ** 2
        )

    def t(latitude: float) -> float:
        ratio = (1 - eccentricity * math.sin(latitude)) / (
            1 + eccentricity * math.sin(latitude)
        )
        return math.tan(math.pi / 4 - latitude / 2) / ratio ** (
            eccentricity / 2
        )

    # two standard parallels define the Lambert cone
    latitude_1, latitude_2 = map(math.radians, STANDARD_PARALLELS)
    latitude_0 = math.radians(LATITUDE_OF_ORIGIN)
    longitude_0 = math.radians(CENTRAL_MERIDIAN)
    cone_constant = math.log(m(latitude_1) / m(latitude_2)) / math.log(
        t(latitude_1) / t(latitude_2)
    )
    scale_factor = m(latitude_1) / (
        cone_constant * t(latitude_1) ** cone_constant
    )
    rho_0 = (
        SEMI_MAJOR_AXIS_METERS
        * scale_factor
        * t(latitude_0) ** cone_constant
    )

    # remove false origin after converting stored international feet to meters
    x = x_feet * METERS_PER_FOOT - FALSE_EASTING_FEET * METERS_PER_FOOT
    y = y_feet * METERS_PER_FOOT
    rho = math.hypot(x, rho_0 - y)
    theta = math.atan2(x, rho_0 - y)
    conformal_t = (rho / (SEMI_MAJOR_AXIS_METERS * scale_factor)) ** (
        1 / cone_constant
    )

    # recover geodetic latitude from conformal latitude by fixed-point iteration
    latitude = math.pi / 2 - 2 * math.atan(conformal_t)
    for _ in range(12):
        ratio = (1 - eccentricity * math.sin(latitude)) / (
            1 + eccentricity * math.sin(latitude)
        )
        updated = math.pi / 2 - 2 * math.atan(
            conformal_t * ratio ** (eccentricity / 2)
        )
        if abs(updated - latitude) < 1e-13:
            latitude = updated
            break
        latitude = updated

    longitude = longitude_0 + theta / cone_constant
    return math.degrees(longitude), math.degrees(latitude)


def optional_number(*values: str) -> int | float | None:
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number == 0 or not math.isfinite(number):
            continue
        return int(number) if number.is_integer() else number
    return None


def iso_date(value: str) -> str | None:
    if len(value) == 8 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value or None


def build_feature(index: int, point: tuple[float, float], row: dict[str, str]) -> dict:
    longitude, latitude = inverse_oregon_lambert(*point)
    camera_height = optional_number(row.get("CamHeight1", ""), row.get("CamHeight", ""))

    properties = {
        "id": f"digitized-camera-{index}",
        "name": row.get("SiteName") or "Digitized camera",
        "operator": row.get("Operator") or "Unknown",
        "status": row.get("Status") or "Unknown",
        "pointSource": row.get("PtSrc") or None,
        "pointSourceName": row.get("PtSrc_Name") or None,
        "mapSource": row.get("MapSource") or None,
        "digitizedBy": row.get("Digit_by") or None,
        "digitizedDate": iso_date(row.get("Digit_date", "")),
        "siteType": row.get("Type") or None,
        "altPointSource": row.get("AltPtSrc") or None,
        "altPointSourceName": row.get("AltSrcName") or None,
        "cameraHeightFeet": camera_height,
        "notes": row.get("Notes") or None,
    }

    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [round(longitude, 6), round(latitude, 6)],
        },
        "properties": properties,
    }


CSV_FIELDS = [
    "id",
    "name",
    "operator",
    "status",
    "pointSource",
    "pointSourceName",
    "altPointSource",
    "altPointSourceName",
    "mapSource",
    "digitizedBy",
    "digitizedDate",
    "siteType",
    "cameraHeightFeet",
    "notes",
    "longitude",
    "latitude",
]


def feature_rows(features: list[dict]) -> list[list]:
    rows = []
    for feature in features:
        longitude, latitude = feature["geometry"]["coordinates"]
        values = {
            **feature["properties"],
            "longitude": longitude,
            "latitude": latitude,
        }
        rows.append([values.get(field) for field in CSV_FIELDS])
    return rows


def write_csv(path: Path, features: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(CSV_FIELDS)
        for row in feature_rows(features):
            writer.writerow(["" if value is None else value for value in row])


def column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def write_xlsx(path: Path, features: list[dict]) -> None:
    # minimal dependency-free workbook: one sheet, inline strings, numeric cells
    all_rows = [CSV_FIELDS, *feature_rows(features)]
    sheet_rows = []
    for row_index, row in enumerate(all_rows, start=1):
        cells = []
        for column_index, value in enumerate(row):
            if value is None or value == "":
                continue
            ref = f"{column_letter(column_index)}{row_index}"
            if isinstance(value, (int, float)):
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
            else:
                cells.append(
                    f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'
                )
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')

    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package = "http://schemas.openxmlformats.org/package/2006/relationships"
    head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    parts = {
        "[Content_Types].xml": head
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>",
        "_rels/.rels": head
        + f'<Relationships xmlns="{package}"><Relationship Id="rId1" '
        f'Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": head
        + f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>'
        '<sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": head
        + f'<Relationships xmlns="{package}"><Relationship Id="rId1" '
        f'Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": head
        + f'<worksheet xmlns="{ns}"><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>',
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)


def main() -> None:
    args = parse_args()
    source = args.source.with_suffix(".shp")
    rows = read_dbf(source.with_suffix(".dbf"))
    points = read_point_z_shapes(source)

    if len(rows) != len(points):
        raise ValueError(
            f"Attribute and geometry counts differ: {len(rows)} rows, {len(points)} points"
        )

    features = [
        build_feature(index, point, row)
        for index, (point, row) in enumerate(zip(points, rows), start=1)
    ]
    feature_collection = {"type": "FeatureCollection", "features": features}

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(feature_collection, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if args.tabular:
        write_csv(args.output.with_suffix(".csv"), features)
        write_xlsx(args.output.with_suffix(".xlsx"), features)

    operators = Counter(feature["properties"]["operator"] for feature in features)
    statuses = Counter(feature["properties"]["status"] for feature in features)
    print(f"Wrote {len(features)} cameras to {args.output}")
    print("Operators:", dict(sorted(operators.items())))
    print("Statuses:", dict(sorted(statuses.items())))


if __name__ == "__main__":
    main()
