'use strict';
// Generates the TerminalShot app icon (gradient rounded square + capture brackets + lens)
// as PNGs at 256/64/32/16 px. Zero dependencies: hand-rolled PNG encoder over zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

// ---------- PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- raster helpers ----------
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (edge, width, d) => clamp01((edge + width - d) / width); // 1 inside, 0 outside

function roundedRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r;
}

function renderIcon(S) {
  const buf = Buffer.alloc(S * S * 4);
  const c = S / 2;
  const inset = S * 0.055;
  const rad = S * 0.235;
  // brand gradient stops
  const g0 = [124, 92, 255], g1 = [56, 217, 245];
  const AA = S * 0.006 + 0.8;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // background rounded square
      const d = roundedRectDist(x + 0.5, y + 0.5, c, c, c - inset, c - inset, rad);
      const bgA = smooth(0, AA, d + AA);
      if (bgA <= 0) { buf[i + 3] = 0; continue; }
      const t = clamp01((x + y) / (2 * S));
      let r = g0[0] + (g1[0] - g0[0]) * t;
      let g = g0[1] + (g1[1] - g0[1]) * t;
      let b = g0[2] + (g1[2] - g0[2]) * t;
      // subtle top sheen + bottom shade
      const sheen = 1 + 0.10 * (1 - y / S) - 0.08 * (y / S);
      r *= sheen; g *= sheen; b *= sheen;

      // white glyph coverage
      let glyph = 0;
      // lens ring
      const dc = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const ringR = S * 0.205, ringW = S * 0.052;
      glyph = Math.max(glyph, smooth(0, AA, Math.abs(dc - ringR) - ringW / 2));
      // lens dot
      glyph = Math.max(glyph, smooth(0, AA, dc - S * 0.066));
      // corner brackets
      const bkOff = S * 0.165, bkLen = S * 0.19, bkTh = S * 0.055, bkR = bkTh / 2;
      const corners = [
        [bkOff, bkOff, 1, 1], [S - bkOff, bkOff, -1, 1],
        [bkOff, S - bkOff, 1, -1], [S - bkOff, S - bkOff, -1, -1],
      ];
      for (const [ox2, oy2, sx, sy] of corners) {
        // horizontal arm
        const hx0 = Math.min(ox2, ox2 + sx * bkLen), hx1 = Math.max(ox2, ox2 + sx * bkLen);
        const dh = segDist(x + 0.5, y + 0.5, hx0, oy2, hx1, oy2);
        glyph = Math.max(glyph, smooth(0, AA, dh - bkR));
        // vertical arm
        const vy0 = Math.min(oy2, oy2 + sy * bkLen), vy1 = Math.max(oy2, oy2 + sy * bkLen);
        const dv = segDist(x + 0.5, y + 0.5, ox2, vy0, ox2, vy1);
        glyph = Math.max(glyph, smooth(0, AA, dv - bkR));
      }
      // don't let brackets collide with ring visually: subtle gap by suppressing glyph in a thin band
      r = r + (255 - r) * glyph;
      g = g + (255 - g) * glyph;
      b = b + (255 - b) * glyph;

      buf[i] = Math.round(clamp01(r / 255) * 255);
      buf[i + 1] = Math.round(clamp01(g / 255) * 255);
      buf[i + 2] = Math.round(clamp01(b / 255) * 255);
      buf[i + 3] = Math.round(bgA * 255);
    }
  }
  return buf;
}

function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / l2;
  t = clamp01(t);
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function downsample(src, S, D) {
  const out = Buffer.alloc(D * D * 4);
  const k = S / D;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const y0 = Math.floor(y * k), y1 = Math.min(S, Math.ceil((y + 1) * k));
      const x0 = Math.floor(x * k), x1 = Math.min(S, Math.ceil((x + 1) * k));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * S + sx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += src[i + 3];
          n++;
        }
      }
      const o = (y * D + x) * 4;
      const am = a / n / 255;
      out[o] = am > 0 ? Math.round(r / n / am) : 0;
      out[o + 1] = am > 0 ? Math.round(g / n / am) : 0;
      out[o + 2] = am > 0 ? Math.round(b / n / am) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
const SS = 1024;
const hi = renderIcon(SS);
for (const size of [256, 64, 48, 32, 16]) {
  const px = downsample(hi, SS, size);
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), encodePNG(px, size, size));
}
console.log('Icons written to', OUT);
