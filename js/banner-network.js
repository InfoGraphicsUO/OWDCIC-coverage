// mockup only: ?banner=cameras fills the banner behind the title and About with drifting
// cameras, each ringed by viewshed circles from img/viewshed-rings.svg, fading out around the
// text. the rings are solid, so a larger camera covers the smaller ones beneath it
import { onSettingChange } from './settings.js';

(() => {
    if (new URLSearchParams(window.location.search).get("banner") !== "cameras") return;

    const banner = document.querySelector(".site-banner");
    const title = banner?.querySelector(".site-banner__title");
    const about = banner?.querySelector(".site-banner__about");
    if (!banner || !title || !about) return;

    const canvas = document.createElement("canvas");
    canvas.className = "site-banner__network";
    canvas.setAttribute("aria-hidden", "true");
    banner.prepend(canvas);
    banner.classList.add("site-banner--network");

    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // still unless the viewer turns on animation in settings, and always still with reduced motion
    let animate = false;
    const still = () => !animate || reduceMotion.matches;

    // spacing between cameras, and how far each one wanders from its home spot
    const SPACING = 52;
    const DRIFT = 3;
    // the rings come from an SVG whose inner ring has radius 50 in a 200-wide viewBox,
    // so the image is drawn at 4x a camera's radius
    const RINGS_SVG = "img/viewshed-rings.svg";
    const RINGS_PER_RADIUS = 4;
    // rasterized once at this size, then scaled down each frame
    const RINGS_RASTER = 512;
    // how far either side of the title and About the rings take to fade out
    const FADE = 56;

    let width = 0;
    let height = 0;
    let nodes = [];
    let clearRects = [];
    let rings = null;
    let frame = 0;

    // seeded so the cameras keep the same layout on every load and resize
    function random(seed) {
        let state = seed >>> 0;
        return () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 4294967296;
        };
    }

    function build() {
        const rand = random(135);
        const columns = Math.max(1, Math.floor(width / SPACING));
        const cellW = width / columns;

        nodes = [];
        for (let col = 0; col < columns; col++) {
            // one or two cameras per column, so the rings overlap unevenly like real coverage
            const count = rand() < 0.4 ? 2 : 1;
            for (let n = 0; n < count; n++) {
                nodes.push({
                    homeX: (col + 0.1 + rand() * 0.8) * cellW,
                    homeY: height * (0.15 + rand() * 0.7),
                    r: 15 + rand() * 12,
                    phase: rand() * Math.PI * 2,
                    speed: 0.00025 + rand() * 0.00035,
                    pulse: rand() * Math.PI * 2,
                    x: 0,
                    y: 0,
                });
            }
        }
        // draw the smallest first so larger cameras land on top
        nodes.sort((a, b) => a.r - b.r);
    }

    function resize() {
        const bannerRect = banner.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const aboutRect = about.getBoundingClientRect();
        const left = titleRect.left - bannerRect.left;

        width = Math.max(0, bannerRect.width - left);
        height = bannerRect.height - 5;
        // the text the rings fade away from, in canvas coordinates
        clearRects = [titleRect, aboutRect].map((rect) => ({
            left: rect.left - bannerRect.left - left,
            right: rect.right - bannerRect.left - left,
            top: rect.top - bannerRect.top,
            bottom: rect.bottom - bannerRect.top,
        }));
        canvas.style.left = `${left}px`;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        build();
        draw(performance.now());
    }

    // erase the rings over the title and About, easing them out over FADE pixels either side,
    // so rings can run right up to the text without ever sitting behind it
    function clearAroundText() {
        ctx.globalCompositeOperation = "destination-out";
        for (const rect of clearRects) {
            const from = rect.left - FADE;
            const span = rect.right - rect.left + FADE * 2;
            const edge = FADE / span;
            const gradient = ctx.createLinearGradient(from, 0, from + span, 0);
            gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
            gradient.addColorStop(edge * 0.5, "rgba(0, 0, 0, 0.5)");
            gradient.addColorStop(edge, "#000");
            gradient.addColorStop(1 - edge, "#000");
            gradient.addColorStop(1 - edge * 0.5, "rgba(0, 0, 0, 0.5)");
            gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
            ctx.fillStyle = gradient;
            ctx.fillRect(from, 0, span, height);
        }
        ctx.globalCompositeOperation = "source-over";
    }

    function draw(time) {
        ctx.clearRect(0, 0, width, height);
        const t = still() ? 0 : time;
        if (!rings) return;

        for (const node of nodes) {
            node.x = node.homeX + Math.cos(t * node.speed + node.phase) * DRIFT;
            node.y = node.homeY + Math.sin(t * node.speed * 1.3 + node.phase) * DRIFT;
        }

        for (const node of nodes) {
            // the rings breathe very slightly, as if the viewshed is scanning
            const breathe = still() ? 1 : 1 + 0.04 * Math.sin(t * 0.0008 + node.pulse);
            const size = node.r * RINGS_PER_RADIUS * breathe;
            ctx.drawImage(rings, node.x - size / 2, node.y - size / 2, size, size);

            // the camera dot brightens and dims slowly
            const glow = still() ? 0.6 : 0.45 + 0.35 * Math.sin(t * 0.0012 + node.pulse);
            ctx.fillStyle = `rgba(255, 255, 255, ${glow})`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, 1.6, 0, Math.PI * 2);
            ctx.fill();
        }

        clearAroundText();
    }

    function loop(time) {
        draw(time);
        frame = requestAnimationFrame(loop);
    }

    function start() {
        cancelAnimationFrame(frame);
        if (still()) draw(0);
        else frame = requestAnimationFrame(loop);
    }

    // rasterize the SVG once so each frame only scales a bitmap
    const ringsImage = new Image();
    ringsImage.addEventListener("load", () => {
        rings = document.createElement("canvas");
        rings.width = RINGS_RASTER;
        rings.height = RINGS_RASTER;
        rings.getContext("2d").drawImage(ringsImage, 0, 0, RINGS_RASTER, RINGS_RASTER);
        draw(performance.now());
    });
    ringsImage.src = RINGS_SVG;

    new ResizeObserver(resize).observe(banner);
    // the title width changes once its web font loads
    document.fonts?.ready.then(resize);
    reduceMotion.addEventListener("change", start);
    resize();
    // calls back right away with the stored value, which starts the first draw
    onSettingChange("animateBanner", (value) => {
        animate = value;
        start();
    });
})();
