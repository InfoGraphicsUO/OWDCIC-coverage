#!/usr/bin/env python3
"""downloads the USGS 3DEP terrain tiles the viewshed runner reads

    python scripts/fetch-dems.py [--dem-dir data/source/dems]

reads data/source/or-wa-dems-latest.csv and fetches only the tiles missing from the
folder or cut short, about 380 MB each. each tile is written to a .part file first,
so an interrupted download is never mistaken for a finished one, and takes the
server's modification time so copies downloaded on different machines match
"""
from __future__ import annotations

import argparse
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import signal
import sys
import time
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from setup_checks import DEFAULT_DEMS, DEM_TILES, missing_tiles, read_tiles, tile_file  # noqa: E402

PROGRESS_PREFIX = '@@PROGRESS@@'
CHUNK = 1 << 20


class Progress:
    def __init__(self, json_progress: bool, total: int) -> None:
        self.json_progress = json_progress
        self.total = max(total, 1)
        self.done = 0

    def report(self, detail: str, log: bool = True) -> None:
        if self.json_progress:
            event = {'percent': round(100 * self.done / self.total, 1), 'detail': detail}
            print(PROGRESS_PREFIX + json.dumps(event), flush=True)

        if log:
            print(detail, flush=True)


def download(row: dict, dem_dir: Path, progress: Progress, label: str) -> None:
    destination = dem_dir / tile_file(row)
    partial = destination.with_name(destination.name + '.part')
    size = int(row['size_bytes'])
    start = progress.done

    # S3 drops a long transfer now and then, so retry with 5, 10, 20 s waits
    for attempt in range(4):
        progress.done = start
        try:
            with urlopen(row['download_url'], timeout=120) as response, partial.open('wb') as file:
                modified = response.headers.get('Last-Modified')
                reported = 0

                while chunk := response.read(CHUNK):
                    file.write(chunk)
                    progress.done += len(chunk)

                    # one status update per 5% of a tile, and none of them in the log
                    if progress.done - start - reported >= size / 20:
                        reported = progress.done - start
                        progress.report(f'{label}: {reported / size:.0%}', log=False)

            if partial.stat().st_size != size:
                raise OSError(f'got {partial.stat().st_size} of {size} bytes')

            if modified:
                stamp = parsedate_to_datetime(modified).timestamp()
                os.utime(partial, (stamp, stamp))

            partial.replace(destination)
            return
        except KeyboardInterrupt:
            partial.unlink(missing_ok=True)
            raise
        except OSError as error:
            if attempt == 3:
                raise RuntimeError(f'{tile_file(row)} failed: {error}') from error

            progress.report(f'{label}: {error}; retrying')
            time.sleep(5 * 2 ** attempt)


def interrupt(_signum, _frame) -> None:
    raise KeyboardInterrupt


def main(argv: list[str] | None = None) -> int:
    # the GUI's Cancel button terminates the process
    signal.signal(signal.SIGTERM, interrupt)
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dem-dir', type=Path, default=DEFAULT_DEMS)
    parser.add_argument('--tiles', type=Path, default=DEM_TILES, help='tile list with download_url and size_bytes')
    parser.add_argument('--json-progress', action='store_true')
    args = parser.parse_args(argv)
    args.dem_dir.mkdir(parents=True, exist_ok=True)
    rows = read_tiles(args.tiles)
    missing = missing_tiles(args.dem_dir, rows)
    progress = Progress(args.json_progress, sum(int(row['size_bytes']) for row in missing))

    if not missing:
        progress.done = progress.total
        progress.report(f'all {len(rows)} tiles are already in {args.dem_dir}')
        return 0

    progress.report(f'downloading {len(missing)} of {len(rows)} tiles '
                    f'({progress.total / 1e9:.1f} GB) into {args.dem_dir}')

    try:
        for index, row in enumerate(missing, start=1):
            label = f'tile {index}/{len(missing)} {row["tile"]}'
            progress.report(f'{label}: downloading {int(row["size_bytes"]) / 1e6:.0f} MB')
            download(row, args.dem_dir, progress, label)
    except KeyboardInterrupt:
        print('cancelled; finished tiles are kept and the rest download next time', flush=True)
        return 130

    progress.report(f'downloaded {len(missing)} tiles')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f'ERROR: {error}', file=sys.stderr, flush=True)
        raise SystemExit(1) from error
