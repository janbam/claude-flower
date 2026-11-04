// Procedural Claude flower: SDF rasterizer + pose library -> Codex v2 atlas (8x11 cells of 192x208).
// Usage: bun draw.js <out.png>
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/** Cell geometry and palette shared by every frame. */
const CW = 192, CH = 208, COLS = 8, ROWS = 11;
const ORANGE = [215, 117, 86], INK = [17, 17, 17], WHITE = [255, 255, 255];
/** Body proportions in px: outer ray radius, orange core, white face disc, ink outline width. */
const R = 79, CORE = 0.44 * R, FACE = 0.36 * R, OUTLINE = 4.6, STROKE = 3.6;
const CX = 96, CY = 112;

// ---------- tiny math ----------
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const rad = (d) => (d * Math.PI) / 180;
/** Deterministic PRNG so the flower's irregular rays are identical in every frame. */
function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry(7);
const jit = (a) => (rnd() * 2 - 1) * a;
/** The canonical hand-drawn ray set: 12 rays with fixed jitter in angle, length, tip size and bend. */
const RAYS = Array.from({ length: 12 }, (_, i) => ({
  ang: rad(-90 + 15 + i * 30 + jit(6)),
  len: R * (0.93 + jit(0.06)),
  tip: R * (0.088 + jit(0.012)),
  base: R * (0.165 + jit(0.015)),
  bend: jit(0.1),
}));
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
/** Index of the ray closest to a screen angle (deg, 0 = right, 90 = down). */
const rayNear = (deg) => RAYS.map((r, i) => [Math.abs(angDiff(r.ang, rad(deg))), i]).sort((a, b) => a[0] - b[0])[0][1];

/** iq's uneven capsule along +y: radius r1 at origin, r2 at height h. */
function sdUnevenCapsule(x, y, r1, r2, h) {
  x = Math.abs(x);
  const b = (r1 - r2) / h, a = Math.sqrt(1 - b * b), k = -b * x + a * y;
  if (k < 0) return Math.hypot(x, y) - r1;
  if (k > a * h) return Math.hypot(x, y - h) - r2;
  return a * x + b * y - r1;
}
/** Distance from point to a polyline (array of [x,y]). */
function distPolyline(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    d = Math.min(d, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return d;
}
/** Low-frequency wobble so outlines read as marker-drawn; lives in body coordinates so it moves with the body. */
const wobble = (x, y) => 0.55 * Math.sin(x * 0.21 + y * 0.13) + 0.45 * Math.sin(x * -0.11 + y * 0.27 + 1.7);

// ---------- frame description -> layers ----------
/**
 * Turn pose parameters into renderable SDFs. All params optional:
 * dx,dy body offset px; sx,sy body scale; ring rad added to every ray angle;
 * rays(i, ray) -> {da rad, lm length mult, db extra bend};
 * face {ox, oy disc offset px, sq [sx,sy] disc squash, gx, gy feature shift in face units, eyes, mouth, spin, shine, squint}.
 */
function buildFrame(p) {
  const P = { dx: 0, dy: 0, sx: 1, sy: 1, ring: 0, rays: () => ({}), ...p };
  const F = { ox: 0, oy: 0, sq: [1, 1], gx: 0, gy: 0, eyes: "dot", mouth: "omega", ...(p.face || {}) };
  const cx = CX + P.dx, cy = CY + P.dy;
  // Resolve the pose's ray set once; the pixel loop then only evaluates SDFs.
  const rays = RAYS.map((r, i) => {
    const o = P.rays(i, r) || {};
    const ang = r.ang + P.ring + (o.da || 0);
    return { c: Math.cos(ang), s: Math.sin(ang), len: r.len * (o.lm || 1), tip: r.tip, base: r.base, bend: r.bend + (o.db || 0) };
  });
  const k = Math.min(P.sx, P.sy);
  /** Body SDF in px: union of orange core and bent tapered rays, evaluated in squash-corrected local space. */
  const body = (x, y) => {
    const lx = (x - cx) / P.sx, ly = (y - cy) / P.sy, rr = Math.hypot(lx, ly);
    let d = rr - CORE;
    for (const r of rays) {
      const b = r.bend * (rr / R) * (rr / R), cb = Math.cos(b), sb = Math.sin(b);
      const qx = lx * cb - ly * sb, qy = lx * sb + ly * cb;
      const along = qx * r.c + qy * r.s, perp = -qx * r.s + qy * r.c;
      d = Math.min(d, sdUnevenCapsule(perp, along - 0.25 * R, r.base, r.tip, r.len - r.tip - 0.25 * R));
    }
    return (d + wobble(lx, ly) * 0.8) * k;
  };
  // Face disc: a flat sticker surface that slides and foreshortens inside the core to suggest turning.
  const fcx = cx + F.ox * P.sx, fcy = cy + F.oy * P.sy, frx = FACE * P.sx * F.sq[0], fry = FACE * P.sy * F.sq[1];
  const faceSd = (x, y) => (Math.hypot((x - fcx) / frx, (y - fcy) / fry) - 1) * Math.min(frx, fry);
  const U = (u, v) => [fcx + (u + F.gx) * frx, fcy + (v + F.gy) * fry];
  const layers = [];
  const stroke = (pts, w = STROKE, col = INK) => layers.push({ col, sd: (x, y) => distPolyline(x, y, pts) - w / 2, bb: bbox(pts, w) });
  const blob = (u, v, ru, rv, col = INK) => {
    const [x0, y0] = U(u, v), a = ru * frx, b = rv * fry;
    layers.push({ col, sd: (x, y) => (Math.hypot((x - x0) / a, (y - y0) / b) - 1) * Math.min(a, b), bb: [x0 - a - 2, y0 - b - 2, x0 + a + 2, y0 + b + 2] });
  };
  const curve = (fn, n = 14) => Array.from({ length: n + 1 }, (_, i) => U(...fn(i / n)));
  drawEyes(F, { stroke, blob, curve });
  drawMouth(F, { stroke, curve });
  return { body, faceSd, layers };
}
const bbox = (pts, w) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - w, Math.min(...ys) - w, Math.max(...xs) + w, Math.max(...ys) + w];
};

/** Eye vocabulary from thebes' sticker set; eye centres at u=+-0.36, v=-0.18 in face units. */
function drawEyes(F, { stroke, blob, curve }) {
  const v0 = -0.18;
  [-0.36, 0.36].forEach((u0, side) => {
    const s = side ? 1 : -1;
    switch (F.eyes) {
      case "dot": blob(u0, v0, 0.1, 0.18); break;
      case "closed": stroke(curve((t) => [u0 - 0.15 + 0.3 * t, v0 + 0.03 * Math.sin(Math.PI * t)])); break;
      case "happy": stroke(curve((t) => [u0 - 0.15 + 0.3 * t, v0 + 0.06 - 0.2 * Math.sin(Math.PI * t)])); break;
      case "spiral":
        stroke(curve((t) => { const a = t * 3 * Math.PI + (F.spin || 0) * s, r = 0.03 + 0.21 * t; return [u0 + r * Math.cos(a) * s, v0 + r * Math.sin(a)]; }, 40), 2.4);
        break;
      case "plead":
        blob(u0, v0 + 0.02, 0.24, 0.24);
        blob(u0 - 0.06, v0 - 0.05 + (F.shine || 0), 0.11, 0.11, WHITE);
        blob(u0 + 0.09, v0 + 0.11, 0.045, 0.045, WHITE);
        stroke(curve((t) => [u0 - 0.2 * s + 0.4 * s * t, v0 - 0.56 + 0.14 * t - 0.04 * Math.sin(Math.PI * t)]), 2.8);
        break;
      case "focus":
        blob(u0, v0 + 0.04, 0.09, 0.15);
        stroke(curve((t) => [u0 - 0.2 * s + 0.36 * s * t, v0 - 0.26 - 0.14 * t]), 3);
        break;
      case "monocle":
        if (side === 0) {
          blob(u0, v0, 0.09, F.squint ? 0.05 : 0.15);
          stroke(curve((t) => [u0 - 0.18 + 0.34 * t, v0 - 0.32 + 0.1 * t]));
        } else {
          blob(u0, v0, 0.12, F.squint ? 0.06 : 0.17, [105, 105, 105]);
          stroke(curve((t) => [u0 + 0.28 * Math.cos(t * 2 * Math.PI), v0 + 0.3 * Math.sin(t * 2 * Math.PI)], 28), 2.6);
          stroke(curve((t) => [u0 + 0.28 + 0.12 * Math.sin(t * 2), v0 + 0.05 + 1.2 * t], 10), 1.8);
        }
        break;
    }
  });
}
/** Mouth vocabulary; mouth centre at v=+0.32. */
function drawMouth(F, { stroke, curve }) {
  const v0 = 0.32;
  switch (F.mouth) {
    case "omega": stroke(curve((t) => [-0.22 + 0.44 * t, v0 + 0.14 * Math.abs(Math.sin(2 * Math.PI * t))], 20)); break;
    case "smile": stroke(curve((t) => [-0.2 + 0.4 * t, v0 + 0.12 * Math.sin(Math.PI * t)])); break;
    case "open": stroke(curve((t) => [0.13 * Math.cos(2 * Math.PI * t), v0 + 0.06 + 0.13 * Math.sin(2 * Math.PI * t)], 20)); break;
    case "frown": stroke(curve((t) => [-0.1 + 0.2 * t, v0 + 0.08 - 0.08 * Math.sin(Math.PI * t)])); break;
    case "flat": stroke(curve((t) => [-0.18 + 0.36 * t, v0 + 0.02 + 0.04 * t * t])); break;
    case "wavy": stroke(curve((t) => [-0.3 + 0.6 * t, v0 + 0.05 * Math.sin(6 * Math.PI * t + (F.spin || 0))], 24), 3); break;
  }
}

// ---------- rasterizer ----------
/** Render one frame into the atlas buffer at cell (col,row) with analytic SDF anti-aliasing; pixels outside stay transparent. */
function renderCell(buf, col, row, frame) {
  const { body, faceSd, layers } = frame;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const px = x + 0.5, py = y + 0.5, d = body(px, py);
    if (d > 1.5) continue;
    // Composite bottom-up: ink silhouette, orange inset, white face disc, then features in draw order.
    const c = [...INK], a = clamp(0.5 - d, 0, 1);
    const over = (col2, cov) => { for (let k = 0; k < 3; k++) c[k] += (col2[k] - c[k]) * cov; };
    over(ORANGE, clamp(0.5 - (d + OUTLINE), 0, 1));
    over(WHITE, clamp(0.5 - faceSd(px, py), 0, 1));
    for (const L of layers) {
      const [x0, y0, x1, y1] = L.bb;
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) over(L.col, clamp(0.5 - L.sd(px, py), 0, 1));
    }
    const o = ((row * CH + y) * COLS * CW + col * CW + x) * 4;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = Math.round(a * 255);
  }
}

/** Minimal RGBA PNG encoder (no deps). */
function writePng(path, w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(t, 4, "ascii"); data.copy(b, 8);
    b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

// ---------- animation rows ----------
const TAU = 2 * Math.PI;
const LEG_L = rayNear(115), LEG_R = rayNear(65), WAVER = rayNear(-40);
/** Directional locomotion, dir = +1 right / -1 left; drawn per direction rather than pixel-mirrored. */
function walk(dir) {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
    const ph = (k / 8) * TAU, step = Math.sin(ph);
    return {
      dx: 3 * dir, dy: -5 * Math.abs(step), ring: 0.1 * dir,
      sy: 1 - 0.04 * Math.cos(2 * ph), sx: 1 + 0.03 * Math.cos(2 * ph),
      // Legs alternate: the lifted leg shortens and reaches toward travel, the planted one stays long.
      rays: (i) => (i === LEG_L ? { da: -0.12 * dir * Math.max(0, step), lm: 1 - 0.18 * Math.max(0, step) }
        : i === LEG_R ? { da: -0.12 * dir * Math.max(0, -step), lm: 1 - 0.18 * Math.max(0, -step) }
        : { da: 0.04 * dir * Math.sin(ph + i) }),
      face: { eyes: "dot", mouth: "smile", ox: 5 * dir, gx: 0.12 * dir, sq: [0.94, 1] },
    };
  });
}
/** Look directions: the flat face disc slides toward the gaze and foreshortens; near-side rays shorten. */
function look(deg) {
  const a = rad(deg - 90), gx = Math.cos(a), gy = Math.sin(a);
  return {
    rays: (i, r) => { const f = Math.cos(r.ang - a); return { lm: 1 - 0.07 * f, db: 0.08 * Math.sin(r.ang - a) * f }; },
    face: { eyes: "dot", mouth: "smile", ox: 7.5 * gx, oy: 7.5 * gy, gx: 0.2 * gx, gy: 0.2 * gy, sq: [1 - 0.12 * Math.abs(gx), 1 - 0.12 * Math.abs(gy)] },
  };
}
const ph6 = (k) => (k / 6) * TAU;
/** Rows 0-8: pose params per state, in atlas order. */
const ROWS_SPEC = [
  // idle: breathing + blink, rays sway a hair.
  [0, 1, 2, 3, 4, 5].map((k) => ({ sy: 1 + 0.018 * Math.sin(ph6(k)), sx: 1 - 0.01 * Math.sin(ph6(k)), dy: -1.2 * Math.sin(ph6(k)), rays: (i) => ({ da: 0.025 * Math.sin(ph6(k) + i) }), face: { eyes: k === 1 || k === 2 ? "closed" : "dot" } })),
  walk(1),
  walk(-1),
  // waving: upper-right ray rises and waves; happy face.
  [0, 0.45, -0.4, 0.45].map((w, k) => ({ rays: (i) => (i === WAVER ? { da: k ? -0.08 : 0, lm: k ? 1.16 : 1, db: w } : {}), dx: k ? -2 : 0, face: { eyes: "happy", mouth: k ? "open" : "omega", ox: k ? 2 : 0 } })),
  // jumping: anticipation squash, launch stretch, peak spread, fall, settle.
  [
    { sy: 0.88, sx: 1.08, dy: 8, face: { eyes: "closed", mouth: "smile" } },
    { sy: 1.08, sx: 0.94, dy: -12, face: { eyes: "happy", mouth: "open", oy: -2 } },
    { dy: -20, rays: () => ({ lm: 1.05 }), face: { eyes: "happy", mouth: "open", oy: -3 } },
    { sy: 1.04, sx: 0.97, dy: -9, face: { eyes: "dot", mouth: "omega", oy: -1 } },
    { sy: 0.93, sx: 1.05, dy: 4, face: { eyes: "happy", mouth: "omega" } },
  ],
  // failed: dizzy spiral eyes, rays wilt downward progressively, body sags.
  [0, 1, 2, 3, 4, 5, 6, 7].map((k) => { const t = Math.min(1, k / 4); return { dy: 6 * t, sy: 1 - 0.07 * t, sx: 1 + 0.04 * t, rays: (i, r) => ({ da: 0.5 * t * Math.cos(r.ang) * (1 + 0.1 * Math.sin(k + i)), lm: 1 - 0.1 * t * (r.ang < 0 ? 1 : 0.3) }), face: { eyes: "spiral", mouth: "wavy", spin: k * 0.9, oy: 3 * t } }; }),
  // waiting: calm, content face with a slow blink; top rays lifted like hands, gentle patient sway.
  [0, 1, 2, 3, 4, 5].map((k) => { const s = Math.sin(ph6(k)); return { dx: 2.5 * s, rays: (i, r) => ({ da: r.ang < 0 ? 0.06 * s : 0, lm: r.ang < -0.3 ? 1.04 + 0.03 * Math.cos(ph6(k) + i) : 1 }), face: { eyes: k === 4 ? "closed" : "dot", mouth: "smile", ox: 1.5 * s } }; }),
  // running (working): cheerful busy hum, a pulse wave travels round the rays, eyes scan, one happy squint.
  [0, 1, 2, 3, 4, 5].map((k) => ({ rays: (i, r) => ({ lm: 1 + 0.07 * Math.sin(r.ang * 2 - ph6(k)), db: 0.1 * Math.sin(r.ang - ph6(k)) }), dy: -1.5 * Math.abs(Math.sin(ph6(k))), face: { eyes: k === 3 ? "happy" : "dot", mouth: k % 2 ? "omega" : "smile", gx: 0.08 * Math.sin(ph6(k)), gy: 0.02 } })),
  // review: monocle inspection, peering lean left->right, a squint.
  [0, 1, 2, 3, 4, 5].map((k) => { const s = Math.sin(ph6(k)); return { dx: 2 * s, rays: () => ({ da: 0.04 * s }), face: { eyes: "monocle", mouth: "flat", ox: 3 * s, oy: 2, gx: 0.06 * s, squint: k === 3 } }; }),
];

// ---------- assemble ----------
const buf = new Uint8ClampedArray(COLS * CW * ROWS * CH * 4);
ROWS_SPEC.forEach((frames, row) => frames.forEach((p, col) => renderCell(buf, col, row, buildFrame(p))));
// v2 contract: cell (row 0, col 6) is the neutral/front look frame the 16 directions orbit around.
renderCell(buf, 6, 0, buildFrame({ face: { eyes: "dot", mouth: "smile" } }));
for (let k = 0; k < 16; k++) renderCell(buf, k % 8, 9 + Math.floor(k / 8), buildFrame(look(k * 22.5)));
writePng(process.argv[2] || "atlas.png", COLS * CW, ROWS * CH, buf);
console.log("ok");
