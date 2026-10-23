// mockup only: ?banner=cameras fills the empty banner space between the title and About
// with a small drifting network of cameras (rings) linked by viewshed lines
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
    const SPACING = 21;
    const DRIFT = 2;
    const LINE_ALPHA = 0.28;
    const RING_ALPHA = 0.42;

    let width = 0;
    let height = 0;
    let nodes = [];
    let links = [];
    let rays = [];
    let frame = 0;

    // seeded so the network keeps the same shape on every load and resize
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
        const rows = Math.max(1, Math.floor(height / SPACING));
        const cellW = width / columns;
        const cellH = height / rows;

        nodes = [];
        for (let col = 0; col < columns; col++) {
            for (let row = 0; row < rows; row++) {
                // leave some cells empty so the network reads as scattered sites, not a grid
                if (rand() < 0.22) continue;
                nodes.push({
                    homeX: (col + 0.2 + rand() * 0.6) * cellW,
                    homeY: (row + 0.2 + rand() * 0.6) * cellH,
                    r: 2.2 + rand() * 1.8,
                    phase: rand() * Math.PI * 2,
                    speed: 0.00025 + rand() * 0.00035,
                    pulse: rand() * Math.PI * 2,
                    x: 0,
                    y: 0,
                });
            }
        }

        // link each camera to its nearest one or two neighbours
        links = [];
        const seen = new Set();
        nodes.forEach((node, i) => {
            const nearest = nodes
                .map((other, j) => ({ j, d: Math.hypot(other.homeX - node.homeX, other.homeY - node.homeY) }))
                .filter(({ j, d }) => j !== i && d < SPACING * 1.9)
                .sort((a, b) => a.d - b.d)
                .slice(0, rand() < 0.5 ? 1 : 2);

            for (const { j } of nearest) {
                const key = i < j ? `${i}-${j}` : `${j}-${i}`;
                if (seen.has(key)) continue;
                seen.add(key);
                // some links bend once, like a viewshed edge meeting another camera's
                links.push({ a: i, b: j, bend: rand() < 0.25 ? (rand() - 0.5) * 0.9 : 0 });
            }
        });

        // a few loose sight lines run out from cameras toward the edges
        rays = nodes
            .map((node, i) => ({ i, angle: rand() * Math.PI * 2, length: 8 + rand() * 16, keep: rand() < 0.35 }))
            .filter((ray) => ray.keep);
    }

    function resize() {
        const bannerRect = banner.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const aboutRect = about.getBoundingClientRect();
        const left = titleRect.right - bannerRect.left + 24;
        const right = aboutRect.left - bannerRect.left - 16;

        width = Math.max(0, right - left);
        height = bannerRect.height - 5;
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

    // line from the edge of one ring to the edge of another, leaving a small gap like the sketch
    function edgePoint(from, to, r) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        return [from.x + Math.cos(angle) * (r + 1), from.y + Math.sin(angle) * (r + 1)];
    }

    function draw(time) {
        ctx.clearRect(0, 0, width, height);
        const t = reduceMotion.matches ? 0 : time;

        for (const node of nodes) {
            node.x = node.homeX + Math.cos(t * node.speed + node.phase) * DRIFT;
            node.y = node.homeY + Math.sin(t * node.speed * 1.3 + node.phase) * DRIFT;
        }

        ctx.lineWidth = 0.6;
        ctx.strokeStyle = `rgba(255, 255, 255, ${LINE_ALPHA})`;
        ctx.beginPath();
        for (const { a, b, bend } of links) {
            const from = nodes[a];
            const to = nodes[b];
            if (bend) {
                const midX = (from.x + to.x) / 2 - (to.y - from.y) * bend;
                const midY = (from.y + to.y) / 2 + (to.x - from.x) * bend;
                const mid = { x: midX, y: midY };
                ctx.moveTo(...edgePoint(from, mid, from.r));
                ctx.lineTo(midX, midY);
                ctx.lineTo(...edgePoint(to, mid, to.r));
            } else {
                ctx.moveTo(...edgePoint(from, to, from.r));
                ctx.lineTo(...edgePoint(to, from, to.r));
            }
        }
        for (const { i, angle, length } of rays) {
            const node = nodes[i];
            const sway = reduceMotion.matches ? 0 : Math.sin(t * node.speed * 2 + node.pulse) * 0.15;
            const cos = Math.cos(angle + sway);
            const sin = Math.sin(angle + sway);
            ctx.moveTo(node.x + cos * (node.r + 1), node.y + sin * (node.r + 1));
            ctx.lineTo(node.x + cos * (node.r + length), node.y + sin * (node.r + length));
        }
        ctx.stroke();

        for (const node of nodes) {
            ctx.strokeStyle = `rgba(255, 255, 255, ${RING_ALPHA})`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
            ctx.stroke();

            // the camera dot breathes slowly
            const glow = reduceMotion.matches ? 0.6 : 0.45 + 0.35 * Math.sin(t * 0.0012 + node.pulse);
            ctx.fillStyle = `rgba(255, 255, 255, ${glow})`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, 0.8, 0, Math.PI * 2);
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
