'use strict';
// Area / scroll-region selection over a frozen screenshot, plus a click-through
// "frame" mode that outlines the recorded region during scrolling capture.
const { ipcRenderer } = require('electron');

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const magEl = document.getElementById('mag');
const magCv = document.getElementById('magCv');
const magCtx = magCv.getContext('2d');
const hintEl = document.getElementById('hint');
const hintText = document.getElementById('hintText');
const sizeBadge = document.getElementById('sizeBadge');

let mode = 'area';          // 'area' | 'scroll' | 'frame'
let img = null;             // frozen screenshot (Image)
let src = null;             // offscreen canvas with frozen pixels (device px)
let srcCtx = null;
let iw = 0, ih = 0;         // frozen image size (device px)
let ratio = 1;              // css px -> image px
let dpr = 1;
let cursor = { x: -1, y: -1 };   // css px
let drag = null;            // {x0,y0,x1,y1} css px
let frameRect = null;       // css rect in frame mode
let dirty = false;

const ACC = '#6c8cff';
const ACC2 = '#22d3ee';

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(window.innerWidth * dpr);
  cv.height = Math.round(window.innerHeight * dpr);
}

function requestRender() {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => { dirty = false; render(); });
}

// ------------------------------------------------------------------ render
function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);

  if (mode === 'frame') {
    if (!frameRect) return;
    const s = dpr;
    const x = frameRect.x * s, y = frameRect.y * s, w = frameRect.w * s, h = frameRect.h * s;
    // accent frame fully OUTSIDE the region so it never contaminates captures:
    // one clean 2px line with a soft glow (glow spreads outward only — the
    // inner edge is clipped so region pixels stay untouched)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cv.width, cv.height);
    ctx.rect(x - 3 * s, y - 3 * s, w + 6 * s, h + 6 * s);
    ctx.clip('evenodd');
    ctx.shadowColor = 'rgba(108,140,255,0.72)';
    ctx.shadowBlur = 12 * s;
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = ACC;
    ctx.strokeRect(x - 4 * s, y - 4 * s, w + 8 * s, h + 8 * s);
    ctx.restore();
    return;
  }

  if (!img) return;
  // frozen screenshot 1:1
  ctx.drawImage(img, 0, 0, iw, ih, 0, 0, cv.width, cv.height);
  // dim veil
  ctx.fillStyle = 'rgba(6, 7, 12, 0.44)';
  ctx.fillRect(0, 0, cv.width, cv.height);

  const s = dpr;
  if (drag) {
    const r = normRect(drag);
    const x = r.x * s, y = r.y * s, w = r.w * s, h = r.h * s;
    // undimmed selection
    ctx.drawImage(img, r.x * ratio, r.y * ratio, r.w * ratio, r.h * ratio, x, y, w, h);
    // border + glow
    ctx.save();
    ctx.shadowColor = 'rgba(108,140,255,0.76)';
    ctx.shadowBlur = 14 * s;
    ctx.strokeStyle = ACC;
    ctx.lineWidth = 1.6 * s;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
    // corner handles
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = ACC;
    ctx.lineWidth = 1.5 * s;
    const hs = 3.6 * s;
    for (const [hx, hy] of [
      [x, y], [x + w / 2, y], [x + w, y],
      [x, y + h / 2], [x + w, y + h / 2],
      [x, y + h], [x + w / 2, y + h], [x + w, y + h],
    ]) {
      ctx.beginPath();
      ctx.arc(hx, hy, hs, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (cursor.x >= 0) {
    // full-screen crosshair guides
    ctx.strokeStyle = 'rgba(160, 140, 255, 0.55)';
    ctx.lineWidth = 1;
    const cx = Math.round(cursor.x * s) + 0.5, cy = Math.round(cursor.y * s) + 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, cv.height);
    ctx.moveTo(0, cy); ctx.lineTo(cv.width, cy);
    ctx.stroke();
  }
}

function normRect(d) {
  return {
    x: Math.min(d.x0, d.x1),
    y: Math.min(d.y0, d.y1),
    w: Math.abs(d.x1 - d.x0),
    h: Math.abs(d.y1 - d.y0),
  };
}

// ------------------------------------------------------------------ magnifier
function renderMag() {
  if (!srcCtx || cursor.x < 0) { magEl.style.display = 'none'; return; }
  magEl.style.display = 'block';

  const px = Math.min(iw - 1, Math.max(0, Math.round(cursor.x * ratio)));
  const py = Math.min(ih - 1, Math.max(0, Math.round(cursor.y * ratio)));

  const N = 11;               // sample N×N device pixels
  const Z = 176 / N;
  magCtx.imageSmoothingEnabled = false;
  magCtx.fillStyle = '#05060a';
  magCtx.fillRect(0, 0, 176, 176);
  magCtx.drawImage(src, px - (N - 1) / 2, py - (N - 1) / 2, N, N, 0, 0, 176, 176);

  // pixel grid
  magCtx.strokeStyle = 'rgba(255,255,255,0.07)';
  magCtx.lineWidth = 1;
  magCtx.beginPath();
  for (let i = 1; i < N; i++) {
    magCtx.moveTo(i * Z + 0.5, 0); magCtx.lineTo(i * Z + 0.5, 176);
    magCtx.moveTo(0, i * Z + 0.5); magCtx.lineTo(176, i * Z + 0.5);
  }
  magCtx.stroke();

  // center pixel highlight
  const c = (N - 1) / 2 * Z;
  magCtx.strokeStyle = ACC2;
  magCtx.lineWidth = 1.6;
  magCtx.strokeRect(c + 0.8, c + 0.8, Z - 1.6, Z - 1.6);
  // crosshair lines
  magCtx.strokeStyle = 'rgba(56,217,245,0.35)';
  magCtx.lineWidth = 1;
  magCtx.beginPath();
  magCtx.moveTo(c + Z / 2, 0); magCtx.lineTo(c + Z / 2, c);
  magCtx.moveTo(c + Z / 2, c + Z); magCtx.lineTo(c + Z / 2, 176);
  magCtx.moveTo(0, c + Z / 2); magCtx.lineTo(c, c + Z / 2);
  magCtx.moveTo(c + Z, c + Z / 2); magCtx.lineTo(176, c + Z / 2);
  magCtx.stroke();

  // info
  let hex = '#??????';
  try {
    const d = srcCtx.getImageData(px, py, 1, 1).data;
    hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch {}
  document.getElementById('magPos').textContent = `${px}, ${py}`;
  document.getElementById('magHex').textContent = hex.toUpperCase();
  document.getElementById('magSwatch').style.background = hex;
  const selRow = document.getElementById('magSel');
  if (drag) {
    const r = normRect(drag);
    selRow.textContent = `${Math.round(r.w * ratio)} × ${Math.round(r.h * ratio)}`;
  } else {
    selRow.textContent = '—';
  }

  // position: offset from cursor, flip near edges
  const off = 26;
  const mw = 178, mh = 176 + 52;
  let mx = cursor.x + off, my = cursor.y + off;
  if (mx + mw > window.innerWidth - 8) mx = cursor.x - off - mw;
  if (my + mh > window.innerHeight - 8) my = cursor.y - off - mh;
  mx = Math.max(8, mx); my = Math.max(8, my);
  magEl.style.transform = `translate(${Math.round(mx)}px, ${Math.round(my)}px)`;
}

function renderBadge() {
  if (!drag) { sizeBadge.style.display = 'none'; return; }
  const r = normRect(drag);
  sizeBadge.textContent = `${Math.round(r.w * ratio)} × ${Math.round(r.h * ratio)}`;
  sizeBadge.style.display = 'block';
  let bx = r.x, by = r.y - 30;
  if (by < 6) by = r.y + 8;
  bx = Math.min(bx, window.innerWidth - sizeBadge.offsetWidth - 8);
  sizeBadge.style.left = Math.max(6, bx) + 'px';
  sizeBadge.style.top = by + 'px';
}

// ------------------------------------------------------------------ input
window.addEventListener('mousemove', e => {
  if (mode === 'frame') return;
  cursor = { x: e.clientX, y: e.clientY };
  if (drag) { drag.x1 = e.clientX; drag.y1 = e.clientY; }
  requestRender();
  renderMag();
  renderBadge();
});

window.addEventListener('mousedown', e => {
  if (mode === 'frame') return;
  if (e.button === 2) { cancel(); return; }
  if (e.button !== 0) return;
  drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
  requestRender();
});

window.addEventListener('mouseup', e => {
  if (mode === 'frame' || !drag || e.button !== 0) return;
  const r = normRect(drag);
  const rect = {
    x: Math.round(r.x * ratio),
    y: Math.round(r.y * ratio),
    width: Math.round(r.w * ratio),
    height: Math.round(r.h * ratio),
  };
  const done = rect.width >= 4 && rect.height >= 4;
  drag = null;
  if (done) {
    rect.x = Math.max(0, Math.min(rect.x, iw - 1));
    rect.y = Math.max(0, Math.min(rect.y, ih - 1));
    rect.width = Math.min(rect.width, iw - rect.x);
    rect.height = Math.min(rect.height, ih - rect.y);
    ipcRenderer.send('overlay:done', { rect, mode });
  } else {
    requestRender();
    renderBadge();
  }
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') cancel();
});
window.addEventListener('contextmenu', e => e.preventDefault());

function cancel() {
  if (mode === 'frame') return;
  ipcRenderer.send('overlay:cancel');
  reset();
}

function reset() {
  drag = null;
  cursor = { x: -1, y: -1 };
  magEl.style.display = 'none';
  sizeBadge.style.display = 'none';
}

// ------------------------------------------------------------------ ipc
ipcRenderer.on('overlay:begin', (e, payload) => {
  mode = payload.mode;
  document.body.classList.remove('frame-mode');
  frameRect = null;
  reset();
  resizeCanvas();
  iw = payload.iw; ih = payload.ih;
  ratio = iw / window.innerWidth;

  hintText.textContent = mode === 'scroll'
    ? 'Select the region to scroll-capture'
    : mode === 'page'
      ? 'Select the scrolling content — capture runs automatically from the top'
      : 'Drag to select an area';
  hintEl.classList.add('show');

  img = new Image();
  img.onload = () => {
    src = document.createElement('canvas');
    src.width = iw; src.height = ih;
    srcCtx = src.getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(img, 0, 0);
    render();
    ipcRenderer.send('overlay:ready');
  };
  img.src = payload.url;
});

ipcRenderer.on('overlay:frame', (e, payload) => {
  mode = 'frame';
  document.body.classList.add('frame-mode');
  frameRect = payload.rect;
  img = null; src = null; srcCtx = null;
  hintEl.classList.remove('show');
  reset();
  resizeCanvas();
  render();
});

window.addEventListener('resize', () => { resizeCanvas(); requestRender(); });
