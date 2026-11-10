// SPDX-License-Identifier: Apache-2.0
// The Rose mark, defined once as geometry and emitted both as SVG and as PNG.
// The PNG path is a tiny signed-distance rasteriser + encoder so icon generation needs
// no native tools or packages. Node builtins only.
import { deflateSync, crc32 } from "node:zlib";

// Geometry on a 64×64 grid. Two open rings and a bud: a rose seen from above.
export const MARK = {
  size: 64,
  radius: 15, // tile corner radius
  arcs: [
    { r: 18, width: 5, start: 200, sweep: 285 },
    { r: 9.5, width: 5, start: 355, sweep: 280 },
  ],
  dot: { r: 2.9 },
};

const rad = (deg) => (deg * Math.PI) / 180;
const pt = (r, deg) => [32 + r * Math.cos(rad(deg)), 32 + r * Math.sin(rad(deg))];
const f = (n) => Number(n.toFixed(2));

function arcPath({ r, start, sweep }) {
  const [x0, y0] = pt(r, start);
  const [x1, y1] = pt(r, start + sweep);
  return `M${f(x0)} ${f(y0)}A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
}

/** Inner glyph only (no tile), for composing into other SVGs. */
export function glyphSvg(fg) {
  return (
    MARK.arcs.map((a) => `<path d="${arcPath(a)}" fill="none" stroke="${fg}" stroke-width="${a.width}" stroke-linecap="round"/>`).join("") +
    `<circle cx="32" cy="32" r="${MARK.dot.r}" fill="${fg}"/>`
  );
}

/** The app mark: rounded tile + glyph. */
export function markSvg({ bg, fg, title = "Rose" }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${title}"><title>${title}</title><rect width="64" height="64" rx="${MARK.radius}" fill="${bg}"/>${glyphSvg(fg)}</svg>\n`;
}

/** Favicon that adapts to the browser's colour scheme. */
export function faviconSvg({ bg, fg, bgDark, fgDark }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.t{fill:${bg}}.g{stroke:${fg}}.d{fill:${fg}}@media (prefers-color-scheme:dark){.t{fill:${bgDark}}.g{stroke:${fgDark}}.d{fill:${fgDark}}}</style><rect class="t" width="64" height="64" rx="${MARK.radius}"/>${MARK.arcs
    .map((a) => `<path class="g" d="${arcPath(a)}" fill="none" stroke-width="${a.width}" stroke-linecap="round"/>`)
    .join("")}<circle class="d" cx="32" cy="32" r="${MARK.dot.r}"/></svg>\n`;
}

export function wordmarkSvg({ bg, fg, text, name }) {
  const width = 64 + 18 + Math.ceil(name.length * 25.5) + 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 64" role="img" aria-label="${name}"><title>${name}</title><rect width="64" height="64" rx="${MARK.radius}" fill="${bg}"/>${glyphSvg(fg)}<text x="82" y="46" font-family="ui-sans-serif, Inter, 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif" font-size="42" font-weight="650" letter-spacing="-1.2" fill="${text}">${name.replace(/[<&>]/g, "")}</text></svg>\n`;
}

// ── Raster ───────────────────────────────────────────────────────────────────────
export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x - 32) - (half - r);
  const qy = Math.abs(y - 32) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdArc(x, y, a) {
  const dx = x - 32;
  const dy = y - 32;
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  ang = (((ang - a.start) % 360) + 360) % 360;
  if (ang <= a.sweep) return Math.abs(Math.hypot(dx, dy) - a.r) - a.width / 2;
  const [x0, y0] = pt(a.r, a.start);
  const [x1, y1] = pt(a.r, a.start + a.sweep);
  return Math.min(Math.hypot(x - x0, y - y0), Math.hypot(x - x1, y - y1)) - a.width / 2;
}

/**
 * Render the mark to RGBA. `inset` (0–0.3) shrinks the glyph and fills the whole square,
 * which is what "maskable" and Apple touch icons want (the OS applies its own mask).
 */
export function renderMark(px, { bg, fg, fullBleed = false, glyphScale = 1 }) {
  const [br, bgG, bb] = hexToRgb(bg);
  const [fr, fgG, fb] = hexToRgb(fg);
  const out = Buffer.alloc(px * px * 4);
  const unit = 64 / px; // grid units per pixel
  const cover = (d) => Math.min(1, Math.max(0, 0.5 - d / unit));
  for (let j = 0; j < px; j++) {
    for (let i = 0; i < px; i++) {
      const x = (i + 0.5) * unit;
      const y = (j + 0.5) * unit;
      const tile = fullBleed ? 1 : cover(sdRoundRect(x, y, 32, MARK.radius));
      const gx = 32 + (x - 32) / glyphScale;
      const gy = 32 + (y - 32) / glyphScale;
      let d = Math.hypot(gx - 32, gy - 32) - MARK.dot.r;
      for (const a of MARK.arcs) d = Math.min(d, sdArc(gx, gy, a));
      const g = Math.min(1, Math.max(0, 0.5 - (d * glyphScale) / unit));
      const o = (j * px + i) * 4;
      out[o] = Math.round(br + (fr - br) * g);
      out[o + 1] = Math.round(bgG + (fgG - bgG) * g);
      out[o + 2] = Math.round(bb + (fb - bb) * g);
      out[o + 3] = Math.round(tile * 255);
    }
  }
  return out;
}

export function encodePng(rgba, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((px * 4 + 1) * px);
  for (let y = 0; y < px; y++) rgba.copy(raw, y * (px * 4 + 1) + 1, y * px * 4, (y + 1) * px * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export const markPng = (px, opts) => encodePng(renderMark(px, opts), px);
