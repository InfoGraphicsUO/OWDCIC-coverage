"""reads data/source/camera-providers.json, the one list of camera providers and Pano AI owners

each provider keeps its sites in data/live/<id>-sites.geojson and its viewsheds in
outputs/gdal_viewsheds_<id>; ALERTWest viewshed ids are unprefixed and every other
provider's start with "<id>-" so tilesets never share one
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / 'data/source/camera-providers.json'

_registry = json.loads(REGISTRY.read_text(encoding='utf-8'))
# in the order the map lists them
PROVIDERS = _registry['providers']
PROVIDER_LABELS = {provider: record['label'] for provider, record in PROVIDERS.items()}
PANO_OWNERS = _registry['panoOwners']


def sites_path(provider):
    return ROOT / f'data/live/{provider}-sites.geojson'


def output_dir(provider):
    return ROOT / f'outputs/gdal_viewsheds_{provider}'


def viewshed_prefix(provider):
    return '' if provider == 'alertwest' else f'{provider}-'


def pano_owner(title):
    """names the owner a Pano AI table's title row belongs to"""
    upper = title.upper()
    owner = next((name for name, record in PANO_OWNERS.items() if record['sheetTitle'] in upper), None)

    if owner is None:
        raise ValueError(
            f'no Pano AI owner matches the sheet table "{title.strip()}"; '
            f'add the owner and its public viewer to {REGISTRY.relative_to(ROOT)}'
        )

    return owner
