/**
 * rasterization pipeline shared by every SVG map marker in img/
 *
 * Mapbox samples its icon atlas with bilinear filtering and no mipmaps, so an
 * image only looks sharp when its pixels line up with physical screen pixels.
 * Each marker file is therefore rasterized at the reported device pixel ratio
 * and drawn at icon-size 1 so Mapbox never rescales it.
 */

const MAX_PIXEL_RATIO = 4;
const registeredIcons = new Map();
const svgSources = new Map();

// image id for one entry of a multi-size icon family
export function sizedIconId(id, size) {
  return `${id}-${size}`;
}

/**
 * registers a marker image and remembers it for later density rebuilds
 * size is the on-screen size in CSS pixels at icon-size 1
 */
export async function registerMarkerIcon(map, { id, url, size }) {
  registeredIcons.set(id, { url, size });
  await rasterizeInto(map, id, url, size);
}

/**
 * registers one image per size so layers can switch images instead of scaling
 * a single one, which is what keeps variable-size markers crisp
 */
export async function registerMarkerIconSizes(map, { id, url, sizes }) {
  await Promise.all(
    sizes.map((size) =>
      registerMarkerIcon(map, { id: sizedIconId(id, size), url, size })
    )
  );
}

// browser zoom and monitor moves change devicePixelRatio without a resize event
export function watchMarkerIconDensity(map) {
  onPixelRatioChange(() => {
    const rebuilds = [...registeredIcons].map(([id, { url, size }]) =>
      rasterizeInto(map, id, url, size)
    );

    Promise.all(rebuilds).catch((error) =>
      console.error('Failed to rescale marker icons:', error)
    );
  });
}

async function rasterizeInto(map, id, url, size) {
  const pixelRatio = markerPixelRatio();
  const image = await rasterizeSvg(await loadSvgSource(url), size, pixelRatio);

  // addImage cannot change the density of an image that already exists
  if (map.hasImage(id)) map.removeImage(id);

  map.addImage(id, image, { pixelRatio });
}

function loadSvgSource(url) {
  if (!svgSources.has(url)) {
    const source = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`Marker icon HTTP ${response.status}: ${url}`);
      }

      return response.text();
    });

    svgSources.set(url, source);
  }

  return svgSources.get(url);
}

// density that renders one image pixel per physical screen pixel
function markerPixelRatio() {
  const ratio = window.devicePixelRatio || 1;
  return Math.min(Math.max(ratio, 1), MAX_PIXEL_RATIO);
}

async function rasterizeSvg(svg, size, pixelRatio) {
  const backingSize = Math.round(size * pixelRatio);

  // marker files carry no width or height, so adding them here makes every
  // browser rasterize at the final resolution instead of scaling up a default
  const sized = svg.replace(
    '<svg',
    `<svg width="${backingSize}" height="${backingSize}"`
  );

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = backingSize;
  canvas.height = backingSize;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');

  context.drawImage(image, 0, 0, backingSize, backingSize);

  return context.getImageData(0, 0, backingSize, backingSize);
}

function onPixelRatioChange(callback) {
  const listen = () => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', handleChange, { once: true });
  };

  const handleChange = () => {
    listen();
    callback();
  };

  listen();
}
