// mockup only: ?banner=cameras fills the banner behind the title and About with drifting
// cameras, each ringed by a few viewshed circles, fading out around the text. each camera's
// rings are solid, so a larger camera covers the smaller ones beneath it
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

    // spacing between cameras, and how far each one wanders from its home spot
    const SPACING = 80;
    const DRIFT = 3;
    // each outer ring is wider and fainter than the one inside it
    const RINGS = [
        { scale: 1, alpha: 0.5 },
        { scale: 1.7, alpha: 0.28 },
        { scale: 2.5, alpha: 0.14 },
    ];
    // how far from the title and About the cameras take to fade fully in
    const FADE = 110;

    let width = 0;
    let height = 0;
    let nodes = [];
    let clearRects = [];
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
                    fade: 1,
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
        // the text the cameras fade away from, in canvas coordinates
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

    // 0 on top of the title or About, rising smoothly to 1 at FADE pixels away
    function fadeAt(x, y) {
        let nearest = Infinity;
        for (const rect of clearRects) {
            const dx = Math.max(rect.left - x, 0, x - rect.right);
            const dy = Math.max(rect.top - y, 0, y - rect.bottom);
            nearest = Math.min(nearest, Math.hypot(dx, dy));
        }
        const t = Math.min(nearest / FADE, 1);
        return t * t * (3 - 2 * t);
    }

    function draw(time) {
        ctx.clearRect(0, 0, width, height);
        const t = reduceMotion.matches ? 0 : time;
        const background = getComputedStyle(banner).backgroundColor;

        for (const node of nodes) {
            node.x = node.homeX + Math.cos(t * node.speed + node.phase) * DRIFT;
            node.y = node.homeY + Math.sin(t * node.speed * 1.3 + node.phase) * DRIFT;
            node.fade = fadeAt(node.x, node.y);
        }

        ctx.lineWidth = 1;
        for (const node of nodes) {
            if (node.fade < 0.01) continue;

            // the rings breathe very slightly, as if the viewshed is scanning
            const breathe = reduceMotion.matches ? 1 : 1 + 0.04 * Math.sin(t * 0.0008 + node.pulse);
            const outer = RINGS[RINGS.length - 1];

            // fill the outer ring with the banner colour so it hides anything underneath
            ctx.fillStyle = background;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.r * outer.scale * breathe + 0.5, 0, Math.PI * 2);
            ctx.fill();

            for (const ring of RINGS) {
                ctx.strokeStyle = `rgba(255, 255, 255, ${ring.alpha * node.fade})`;
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.r * ring.scale * breathe, 0, Math.PI * 2);
                ctx.stroke();
            }

            // the camera dot brightens and dims slowly
            const glow = reduceMotion.matches ? 0.6 : 0.45 + 0.35 * Math.sin(t * 0.0012 + node.pulse);
            ctx.fillStyle = `rgba(255, 255, 255, ${glow * node.fade})`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, 1.6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function loop(time) {
        draw(time);
        frame = requestAnimationFrame(loop);
    }

    function start() {
        cancelAnimationFrame(frame);
        if (reduceMotion.matches) draw(0);
        else frame = requestAnimationFrame(loop);
    }

    new ResizeObserver(resize).observe(banner);
    // the title width changes once its web font loads
    document.fonts?.ready.then(resize);
    reduceMotion.addEventListener("change", start);
    resize();
    start();
})();
