'use strict';
// TerminalShot annotation editor — vector annotations over the captured bitmap,
// object-based undo/redo, non-destructive until export (crop re-bases).
const { ipcRenderer } = require('electron');

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const view = $('#view');
const ctx = view.getContext('2d');
const viewport = $('#viewport');
const textEdit = $('#textEdit');
const cropBar = $('#cropBar');

// ---------------------------------------------------------------- state
let doc = null;           // { path, name }
let bases = [];           // canvas per crop generation
let baseIdx = 0;
let ann = [];             // annotation objects (image space)
let undoStack = [], redoStack = [];
let pendingSnap = null;

let tool = 'select';
let style = { color: '#ff5470', width: 4, fill: 'outline', fontSize: 28 };
let zoom = 1, panX = 0, panY = 0;
let sel = -1;             // selected annotation index
let action = null;        // active pointer action
let crop = null;          // crop rect (image space) while crop tool active
let spaceHeld = false;
let textState = null;     // { x, y } while typing
let stepCount = 0;
let dirty = false;
let renderQueued = false;

const dpr = () => window.devicePixelRatio || 1;

// ---------------------------------------------------------------- icons & chrome
$('#wMin').innerHTML = fsIcon('min');
$('#wMax').innerHTML = fsIcon('max');
$('#wClose').innerHTML = fsIcon('x');
$('#btnUndo').innerHTML = fsIcon('undo');
$('#btnRedo').innerHTML = fsIcon('redo');
$('#btnCopy').innerHTML = fsIcon('copy') + '<span>Copy</span>';
$('#btnSave').innerHTML = fsIcon('save') + '<span>Save</span>';
$('#btnSaveAs').innerHTML = fsIcon('saveas') + '<span>Save as…</span>';
$('#zIn').innerHTML = fsIcon('zoomin');
$('#zOut').innerHTML = fsIcon('zoomout');
$('#zFit').innerHTML = fsIcon('fit');
for (const b of $$('.tool')) b.innerHTML = fsIcon(b.dataset.tool);

$('#wMin').addEventListener('click', () => ipcRenderer.send('win:op', { op: 'min' }));
$('#wMax').addEventListener('click', () => ipcRenderer.send('win:op', { op: 'max' }));
$('#wClose').addEventListener('click', () => ipcRenderer.send('win:op', { op: 'hide' }));

function toast(msg) {
  $('#toastMsg').textContent = msg;
  const t = $('#toast');
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

function setDirty(v) {
  dirty = v;
  document.body.classList.toggle('dirty', v);
}

// ---------------------------------------------------------------- coords
const base = () => bases[baseIdx];
const iw = () => (base() ? base().width : 0);
const ih = () => (base() ? base().height : 0);
const s2i = (sx, sy) => ({ x: (sx - panX) / zoom, y: (sy - panY) / zoom });
const i2s = (x, y) => ({ x: x * zoom + panX, y: y * zoom + panY });

function fitView() {
  if (!base()) return;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  zoom = Math.min((vw - 48) / iw(), (vh - 48) / ih(), 1);
  zoom = Math.max(zoom, 0.05);
  panX = (vw - iw() * zoom) / 2;
  panY = (vh - ih() * zoom) / 2;
  updateStatus();
  requestRender();
}

function setZoom(z, cx, cy) {
  z = Math.max(0.08, Math.min(8, z));
  if (cx === undefined) { cx = viewport.clientWidth / 2; cy = viewport.clientHeight / 2; }
  const p = s2i(cx, cy);
  zoom = z;
  panX = cx - p.x * zoom;
  panY = cy - p.y * zoom;
  updateStatus();
  requestRender();
}

function updateStatus(pos) {
  $('#zLevel').textContent = Math.round(zoom * 100) + '%';
  $('#stDims').textContent = base() ? `${iw()} × ${ih()} px` : '—';
  if (pos) $('#stPos').textContent = `${Math.max(0, Math.min(iw(), Math.round(pos.x)))}, ${Math.max(0, Math.min(ih(), Math.round(pos.y)))}`;
}

// ---------------------------------------------------------------- undo/redo
function snapshot() {
  return { ann: JSON.parse(JSON.stringify(ann)), baseIdx, stepCount };
}
function beginMutation() {
  pendingSnap = snapshot();
}
function commitMutation(changed = true) {
  if (changed && pendingSnap) {
    undoStack.push(pendingSnap);
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    setDirty(true);
  }
  pendingSnap = null;
}
function restore(snap) {
  ann = JSON.parse(JSON.stringify(snap.ann));
  baseIdx = Math.min(snap.baseIdx, bases.length - 1);
  stepCount = snap.stepCount;
  sel = -1;
  requestRender();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  setDirty(true);
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  setDirty(true);
}
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);

// ---------------------------------------------------------------- annotation rendering
function annBounds(a) {
  if (a.type === 'pen') {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of a.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const m = a.width / 2 + 2;
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + m * 2, h: y1 - y0 + m * 2 };
  }
  if (a.type === 'line' || a.type === 'arrow') {
    const m = a.width / 2 + 4;
    return {
      x: Math.min(a.x0, a.x1) - m, y: Math.min(a.y0, a.y1) - m,
      w: Math.abs(a.x1 - a.x0) + m * 2, h: Math.abs(a.y1 - a.y0) + m * 2,
    };
  }
  if (a.type === 'text') {
    const m = measureText(a);
    return { x: a.x - 2, y: a.y - 2, w: m.w + 8, h: m.h + 6 };
  }
  if (a.type === 'step') return { x: a.x - a.r, y: a.y - a.r, w: a.r * 2, h: a.r * 2 };
  return { x: a.x, y: a.y, w: a.w, h: a.h }; // rect / ellipse / blur
}

let measureCtx = document.createElement('canvas').getContext('2d');
function measureText(a) {
  measureCtx.font = `600 ${a.size}px "Segoe UI", sans-serif`;
  const lines = a.text.split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  return { w, h: lines.length * a.size * 1.25 };
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function drawAnn(c, a, baseCanvas) {
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  switch (a.type) {
    case 'pen': {
      c.strokeStyle = a.alpha < 1 ? withAlpha(a.color, a.alpha) : a.color;
      c.lineWidth = a.width;
      if (a.alpha < 1) c.globalCompositeOperation = 'multiply';
      const pts = a.pts;
      c.beginPath();
      if (pts.length < 3) {
        c.moveTo(pts[0].x, pts[0].y);
        c.lineTo(pts[pts.length - 1].x + 0.01, pts[pts.length - 1].y + 0.01);
      } else {
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
        }
        c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      }
      c.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      c.strokeStyle = a.color;
      c.lineWidth = a.width;
      c.beginPath();
      c.moveTo(a.x0, a.y0);
      c.lineTo(a.x1, a.y1);
      c.stroke();
      if (a.type === 'arrow') {
        const ang = Math.atan2(a.y1 - a.y0, a.x1 - a.x0);
        const hl = Math.max(11, a.width * 3.4);
        c.beginPath();
        c.moveTo(a.x1, a.y1);
        c.lineTo(a.x1 - hl * Math.cos(ang - 0.46), a.y1 - hl * Math.sin(ang - 0.46));
        c.moveTo(a.x1, a.y1);
        c.lineTo(a.x1 - hl * Math.cos(ang + 0.46), a.y1 - hl * Math.sin(ang + 0.46));
        c.stroke();
      }
      break;
    }
    case 'rect':
    case 'ellipse': {
      c.strokeStyle = a.color;
      c.lineWidth = a.width;
      const path = () => {
        c.beginPath();
        if (a.type === 'rect') {
          const r = Math.min(3, a.w / 2, a.h / 2);
          c.roundRect(a.x, a.y, a.w, a.h, r);
        } else {
          c.ellipse(a.x + a.w / 2, a.y + a.h / 2, Math.max(1, a.w / 2), Math.max(1, a.h / 2), 0, 0, Math.PI * 2);
        }
      };
      if (a.fill === 'fill') { path(); c.fillStyle = a.color; c.fill(); }
      else if (a.fill === 'duo') { path(); c.fillStyle = withAlpha(a.color, 0.18); c.fill(); path(); c.stroke(); }
      else { path(); c.stroke(); }
      break;
    }
    case 'text': {
      c.font = `600 ${a.size}px "Segoe UI", sans-serif`;
      c.textBaseline = 'top';
      c.fillStyle = a.color;
      const lines = a.text.split('\n');
      lines.forEach((l, i) => c.fillText(l, a.x, a.y + i * a.size * 1.25));
      break;
    }
    case 'step': {
      c.beginPath();
      c.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      c.fillStyle = a.color;
      c.shadowColor = 'rgba(0,0,0,0.45)';
      c.shadowBlur = a.r * 0.4;
      c.fill();
      c.shadowBlur = 0;
      c.fillStyle = lumaOf(a.color) > 0.6 ? '#15161e' : '#ffffff';
      c.font = `700 ${a.r * 1.15}px "Segoe UI", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(a.n), a.x, a.y + a.r * 0.06);
      break;
    }
    case 'blur': {
      if (a.w < 2 || a.h < 2) break;
      const key = `${a.x}|${a.y}|${a.w}|${a.h}|${baseIdx}`;
      if (!a._cacheKey || a._cacheKey !== key || !drawAnn._cache.has(a)) {
        const bs = Math.max(5, Math.round(Math.min(a.w, a.h) / 12));
        const tw = Math.max(1, Math.round(a.w / bs)), th = Math.max(1, Math.round(a.h / bs));
        const t = document.createElement('canvas');
        t.width = tw; t.height = th;
        const tc = t.getContext('2d');
        tc.drawImage(baseCanvas, a.x, a.y, a.w, a.h, 0, 0, tw, th);
        drawAnn._cache.set(a, t);
        a._cacheKey = key;
      }
      const t = drawAnn._cache.get(a);
      c.imageSmoothingEnabled = false;
      c.drawImage(t, 0, 0, t.width, t.height, a.x, a.y, a.w, a.h);
      break;
    }
  }
  c.restore();
}
drawAnn._cache = new WeakMap();

function lumaOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// ---------------------------------------------------------------- main render
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const d = dpr();
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  if (view.width !== Math.round(vw * d) || view.height !== Math.round(vh * d)) {
    view.width = Math.round(vw * d);
    view.height = Math.round(vh * d);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  if (!base()) return;

  ctx.setTransform(d * zoom, 0, 0, d * zoom, d * panX, d * panY);
  ctx.imageSmoothingEnabled = zoom < 1;
  ctx.imageSmoothingQuality = 'high';

  // image shadow + bitmap
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 30 / zoom;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, iw(), ih());
  ctx.restore();
  ctx.drawImage(base(), 0, 0);

  for (const a of ann) drawAnn(ctx, a, base());

  // selection chrome
  if (sel >= 0 && ann[sel]) drawSelection(ann[sel]);
  if (tool === 'crop' && crop) drawCrop();
}

function drawSelection(a) {
  const b = annBounds(a);
  const lw = 1.4 / zoom;
  ctx.save();
  ctx.strokeStyle = '#38d9f5';
  ctx.lineWidth = lw;
  ctx.setLineDash([5 / zoom, 4 / zoom]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  for (const h of selectionHandles(a)) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#38d9f5';
    ctx.beginPath();
    ctx.arc(h.x, h.y, 4.4 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function selectionHandles(a) {
  if (a.type === 'line' || a.type === 'arrow') {
    return [{ id: 'p0', x: a.x0, y: a.y0 }, { id: 'p1', x: a.x1, y: a.y1 }];
  }
  if (a.type === 'rect' || a.type === 'ellipse' || a.type === 'blur') {
    const { x, y, w, h } = a;
    return [
      { id: 'nw', x, y }, { id: 'n', x: x + w / 2, y }, { id: 'ne', x: x + w, y },
      { id: 'w', x, y: y + h / 2 }, { id: 'e', x: x + w, y: y + h / 2 },
      { id: 'sw', x, y: y + h }, { id: 's', x: x + w / 2, y: y + h }, { id: 'se', x: x + w, y: y + h },
    ];
  }
  return [];
}

function drawCrop() {
  const r = crop;
  ctx.save();
  ctx.fillStyle = 'rgba(5,6,10,0.62)';
  // dim outside crop
  ctx.beginPath();
  ctx.rect(-panX / zoom, -panY / zoom, viewport.clientWidth / zoom, viewport.clientHeight / zoom);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#8f7bff';
  ctx.lineWidth = 1.6 / zoom;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  // thirds
  ctx.strokeStyle = 'rgba(143,123,255,0.3)';
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(r.x + (r.w * i) / 3, r.y); ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
    ctx.moveTo(r.x, r.y + (r.h * i) / 3); ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
  }
  ctx.stroke();
  // handles
  for (const h of cropHandles()) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#8f7bff';
    ctx.lineWidth = 1.4 / zoom;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 5 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
  positionCropBar();
}

function cropHandles() {
  const { x, y, w, h } = crop;
  return [
    { id: 'nw', x, y }, { id: 'n', x: x + w / 2, y }, { id: 'ne', x: x + w, y },
    { id: 'w', x, y: y + h / 2 }, { id: 'e', x: x + w, y: y + h / 2 },
    { id: 'sw', x, y: y + h }, { id: 's', x: x + w / 2, y: y + h }, { id: 'se', x: x + w, y: y + h },
  ];
}

function positionCropBar() {
  if (!crop) return;
  const p = i2s(crop.x + crop.w, crop.y + crop.h);
  let bx = p.x - cropBar.offsetWidth;
  let by = p.y + 12;
  bx = Math.max(8, Math.min(bx, viewport.clientWidth - cropBar.offsetWidth - 8));
  if (by + cropBar.offsetHeight > viewport.clientHeight - 8) by = p.y - cropBar.offsetHeight - 12;
  by = Math.max(8, by);
  cropBar.style.left = bx + 'px';
  cropBar.style.top = by + 'px';
}

// ---------------------------------------------------------------- hit testing
function hitTest(pt) {
  for (let i = ann.length - 1; i >= 0; i--) {
    const a = ann[i];
    const tolerance = Math.max(6 / zoom, (a.width || 0) / 2 + 4 / zoom);
    if (a.type === 'pen') {
      for (let j = 0; j < a.pts.length - 1; j++) {
        if (segDist(pt, a.pts[j], a.pts[j + 1]) < tolerance) return i;
      }
      if (a.pts.length === 1 && Math.hypot(pt.x - a.pts[0].x, pt.y - a.pts[0].y) < tolerance) return i;
    } else if (a.type === 'line' || a.type === 'arrow') {
      if (segDist(pt, { x: a.x0, y: a.y0 }, { x: a.x1, y: a.y1 }) < tolerance) return i;
    } else if (a.type === 'step') {
      if (Math.hypot(pt.x - a.x, pt.y - a.y) < a.r + 3 / zoom) return i;
    } else if (a.type === 'text') {
      const b = annBounds(a);
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) return i;
    } else if (a.type === 'rect' || a.type === 'ellipse' || a.type === 'blur') {
      const inside = pt.x >= a.x - tolerance && pt.x <= a.x + a.w + tolerance && pt.y >= a.y - tolerance && pt.y <= a.y + a.h + tolerance;
      if (!inside) continue;
      if (a.fill && a.fill !== 'outline') return i;
      if (a.type === 'blur') return i;
      // outline shapes: near the border only
      const nearX = Math.abs(pt.x - a.x) < tolerance || Math.abs(pt.x - (a.x + a.w)) < tolerance;
      const nearY = Math.abs(pt.y - a.y) < tolerance || Math.abs(pt.y - (a.y + a.h)) < tolerance;
      if (nearX || nearY) return i;
    }
  }
  return -1;
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function handleAt(pt, handles) {
  const tol = 8 / zoom;
  for (const h of handles) {
    if (Math.hypot(pt.x - h.x, pt.y - h.y) < tol) return h.id;
  }
  return null;
}

// ---------------------------------------------------------------- pointer input
view.addEventListener('pointerdown', e => {
  if (!base()) return;
  view.setPointerCapture(e.pointerId);
  const pt = s2i(e.offsetX, e.offsetY);

  if (textState) { commitText(); return; }

  if (e.button === 1 || spaceHeld) {
    action = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY };
    view.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;

  if (tool === 'crop') {
    if (crop) {
      const h = handleAt(pt, cropHandles());
      if (h) { action = { kind: 'crop-resize', h, start: { ...crop }, pt }; return; }
      if (pt.x > crop.x && pt.x < crop.x + crop.w && pt.y > crop.y && pt.y < crop.y + crop.h) {
        action = { kind: 'crop-move', start: { ...crop }, pt };
        return;
      }
    }
    action = { kind: 'crop-new', pt };
    crop = { x: pt.x, y: pt.y, w: 0, h: 0 };
    cropBar.classList.remove('show');
    requestRender();
    return;
  }

  if (tool === 'select') {
    if (sel >= 0 && ann[sel]) {
      const h = handleAt(pt, selectionHandles(ann[sel]));
      if (h) {
        beginMutation();
        action = { kind: 'resize', h, start: JSON.parse(JSON.stringify(ann[sel])), pt };
        return;
      }
    }
    const hit = hitTest(pt);
    sel = hit;
    if (hit >= 0) {
      beginMutation();
      action = { kind: 'move', start: JSON.parse(JSON.stringify(ann[hit])), pt, moved: false };
    }
    requestRender();
    return;
  }

  if (tool === 'text') {
    openTextEditor(pt);
    return;
  }

  if (tool === 'step') {
    beginMutation();
    stepCount++;
    ann.push({ type: 'step', x: pt.x, y: pt.y, n: stepCount, r: Math.max(13, style.width * 3 + 8), color: style.color });
    commitMutation();
    requestRender();
    return;
  }

  if (tool === 'pen' || tool === 'highlighter') {
    beginMutation();
    const a = {
      type: 'pen',
      pts: [{ x: pt.x, y: pt.y }],
      color: style.color,
      width: tool === 'highlighter' ? style.width * 3.2 : style.width,
      alpha: tool === 'highlighter' ? 0.42 : 1,
    };
    ann.push(a);
    action = { kind: 'draw-pen', a };
    requestRender();
    return;
  }

  if (tool === 'line' || tool === 'arrow') {
    beginMutation();
    const a = { type: tool, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, color: style.color, width: style.width };
    ann.push(a);
    action = { kind: 'draw-line', a };
    return;
  }

  if (tool === 'rect' || tool === 'ellipse' || tool === 'blur') {
    beginMutation();
    const a = tool === 'blur'
      ? { type: 'blur', x: pt.x, y: pt.y, w: 0, h: 0 }
      : { type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: style.color, width: style.width, fill: style.fill };
    ann.push(a);
    action = { kind: 'draw-shape', a, pt };
    return;
  }
});

view.addEventListener('pointermove', e => {
  const pt = s2i(e.offsetX, e.offsetY);
  updateStatus(pt);
  if (!action) return;

  if (action.kind === 'pan') {
    panX = action.px + (e.clientX - action.sx);
    panY = action.py + (e.clientY - action.sy);
    requestRender();
    return;
  }
  if (action.kind === 'draw-pen') {
    const pts = action.a.pts;
    const last = pts[pts.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) > 1.2 / zoom) pts.push({ x: pt.x, y: pt.y });
    requestRender();
    return;
  }
  if (action.kind === 'draw-line') {
    action.a.x1 = pt.x; action.a.y1 = pt.y;
    if (e.shiftKey) {
      const dx = pt.x - action.a.x0, dy = pt.y - action.a.y0;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      action.a.x1 = action.a.x0 + Math.cos(ang) * len;
      action.a.y1 = action.a.y0 + Math.sin(ang) * len;
    }
    requestRender();
    return;
  }
  if (action.kind === 'draw-shape') {
    let w = pt.x - action.pt.x, h = pt.y - action.pt.y;
    if (e.shiftKey) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    action.a.x = Math.min(action.pt.x, action.pt.x + w);
    action.a.y = Math.min(action.pt.y, action.pt.y + h);
    action.a.w = Math.abs(w);
    action.a.h = Math.abs(h);
    requestRender();
    return;
  }
  if (action.kind === 'move') {
    const dx = pt.x - action.pt.x, dy = pt.y - action.pt.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.5 / zoom) action.moved = true;
    moveAnn(ann[sel], action.start, dx, dy);
    requestRender();
    return;
  }
  if (action.kind === 'resize') {
    resizeAnn(ann[sel], action.start, action.h, pt);
    requestRender();
    return;
  }
  if (action.kind === 'crop-new') {
    crop.x = Math.min(action.pt.x, pt.x);
    crop.y = Math.min(action.pt.y, pt.y);
    crop.w = Math.abs(pt.x - action.pt.x);
    crop.h = Math.abs(pt.y - action.pt.y);
    clampCrop();
    requestRender();
    return;
  }
  if (action.kind === 'crop-move') {
    crop.x = action.start.x + (pt.x - action.pt.x);
    crop.y = action.start.y + (pt.y - action.pt.y);
    crop.x = Math.max(0, Math.min(crop.x, iw() - crop.w));
    crop.y = Math.max(0, Math.min(crop.y, ih() - crop.h));
    requestRender();
    return;
  }
  if (action.kind === 'crop-resize') {
    resizeRect(crop, action.start, action.h, pt);
    clampCrop();
    requestRender();
    return;
  }
});

view.addEventListener('pointerup', e => {
  if (!action) return;
  const kind = action.kind;
  if (kind === 'pan') {
    view.classList.remove('panning');
  } else if (kind === 'draw-pen') {
    commitMutation(true);
  } else if (kind === 'draw-line') {
    const a = action.a;
    if (Math.hypot(a.x1 - a.x0, a.y1 - a.y0) < 3 / zoom) { ann.pop(); pendingSnap = null; }
    else commitMutation(true);
  } else if (kind === 'draw-shape') {
    const a = action.a;
    if (a.w < 3 / zoom || a.h < 3 / zoom) { ann.pop(); pendingSnap = null; }
    else {
      if (a.type === 'blur') delete a._cacheKey;
      commitMutation(true);
    }
  } else if (kind === 'move') {
    commitMutation(action.moved);
  } else if (kind === 'resize') {
    commitMutation(true);
  } else if (kind === 'crop-new') {
    if (crop.w < 4 || crop.h < 4) crop = null;
    cropBar.classList.toggle('show', !!crop);
    requestRender();
  } else if (kind === 'crop-move' || kind === 'crop-resize') {
    cropBar.classList.add('show');
    requestRender();
  }
  action = null;
  requestRender();
});

view.addEventListener('dblclick', e => {
  if (tool !== 'select') return;
  const pt = s2i(e.offsetX, e.offsetY);
  const hit = hitTest(pt);
  if (hit >= 0 && ann[hit].type === 'text') {
    beginMutation();
    const a = ann.splice(hit, 1)[0];
    sel = -1;
    style.fontSize = a.size;
    openTextEditor({ x: a.x, y: a.y }, a.text, a.color);
    requestRender();
  }
});

function moveAnn(a, start, dx, dy) {
  if (a.type === 'pen') {
    a.pts = start.pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
  } else if (a.type === 'line' || a.type === 'arrow') {
    a.x0 = start.x0 + dx; a.y0 = start.y0 + dy;
    a.x1 = start.x1 + dx; a.y1 = start.y1 + dy;
  } else {
    a.x = start.x + dx;
    a.y = start.y + dy;
    if (a.type === 'blur') delete a._cacheKey;
  }
}

function resizeAnn(a, start, h, pt) {
  if (a.type === 'line' || a.type === 'arrow') {
    if (h === 'p0') { a.x0 = pt.x; a.y0 = pt.y; }
    else { a.x1 = pt.x; a.y1 = pt.y; }
    return;
  }
  resizeRect(a, start, h, pt);
  if (a.type === 'blur') delete a._cacheKey;
}

function resizeRect(r, start, h, pt) {
  let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
  if (h.includes('w')) x0 = pt.x;
  if (h.includes('e')) x1 = pt.x;
  if (h.includes('n')) y0 = pt.y;
  if (h.includes('s')) y1 = pt.y;
  r.x = Math.min(x0, x1); r.y = Math.min(y0, y1);
  r.w = Math.max(2, Math.abs(x1 - x0)); r.h = Math.max(2, Math.abs(y1 - y0));
}

function clampCrop() {
  if (!crop) return;
  crop.x = Math.max(0, crop.x); crop.y = Math.max(0, crop.y);
  crop.w = Math.min(crop.w, iw() - crop.x);
  crop.h = Math.min(crop.h, ih() - crop.y);
}

// ---------------------------------------------------------------- text tool
function openTextEditor(pt, initial = '', color = null) {
  textState = { x: pt.x, y: pt.y };
  const p = i2s(pt.x, pt.y);
  textEdit.style.display = 'block';
  textEdit.style.left = (p.x - 6) + 'px';
  textEdit.style.top = (p.y - 4) + 'px';
  textEdit.style.fontSize = style.fontSize * zoom + 'px';
  textEdit.style.color = color || style.color;
  textEdit.textContent = initial;
  setTimeout(() => {
    textEdit.focus();
    const range = document.createRange();
    range.selectNodeContents(textEdit);
    range.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, 10);
}

function commitText() {
  if (!textState) return;
  const text = textEdit.innerText.replace(/\n$/, '');
  const st = textState;
  textState = null;
  textEdit.style.display = 'none';
  if (text.trim()) {
    if (!pendingSnap) beginMutation();
    ann.push({ type: 'text', x: st.x, y: st.y, text, size: style.fontSize, color: style.color });
    commitMutation();
  } else {
    pendingSnap = null;
  }
  requestRender();
}
function cancelText() {
  if (!textState) return;
  textState = null;
  pendingSnap = null;
  textEdit.style.display = 'none';
}

textEdit.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
});
textEdit.addEventListener('blur', () => { if (textState) commitText(); });

// ---------------------------------------------------------------- crop apply
function applyCrop() {
  if (!crop || crop.w < 4 || crop.h < 4) return;
  beginMutation();
  const r = { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) };
  const nc = document.createElement('canvas');
  nc.width = r.w; nc.height = r.h;
  nc.getContext('2d').drawImage(base(), r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  bases = bases.slice(0, baseIdx + 1);
  bases.push(nc);
  baseIdx++;
  for (const a of ann) {
    moveAnn(a, JSON.parse(JSON.stringify(a)), -r.x, -r.y);
    if (a.type === 'blur') delete a._cacheKey;
  }
  commitMutation();
  crop = null;
  cropBar.classList.remove('show');
  setTool('select');
  fitView();
}
function cancelCrop() {
  crop = null;
  cropBar.classList.remove('show');
  setTool('select');
  requestRender();
}
$('#cropApply').addEventListener('click', applyCrop);
$('#cropCancel').addEventListener('click', cancelCrop);

// ---------------------------------------------------------------- tools & options
function setTool(t) {
  if (textState) commitText();
  if (tool === 'crop' && t !== 'crop') { crop = null; cropBar.classList.remove('show'); }
  tool = t;
  sel = -1;
  for (const b of $$('.tool')) b.classList.toggle('on', b.dataset.tool === t);
  view.className = '';
  if (t === 'text') view.classList.add('text-cursor');
  else if (t !== 'select') view.classList.add('tool-cursor');
  const shapeTool = t === 'rect' || t === 'ellipse';
  $('#optFill').style.display = shapeTool ? 'flex' : 'none';
  $('#fillSep').style.display = shapeTool ? 'block' : 'none';
  $('#optFont').style.display = t === 'text' ? 'flex' : 'none';
  $('#optWidth').style.display = t === 'text' || t === 'blur' ? 'none' : 'flex';
  requestRender();
}
for (const b of $$('.tool')) b.addEventListener('click', () => setTool(b.dataset.tool));

function setColor(c) {
  style.color = c;
  for (const s of $$('.swatch')) s.classList.toggle('on', s.dataset.c === c);
  $('#customColor').classList.toggle('on', !$$('.swatch').some(s => s.dataset.c === c));
  $('#widthPreview').style.background = c;
  // recolor selection
  if (sel >= 0 && ann[sel] && ann[sel].color) {
    beginMutation();
    ann[sel].color = c;
    commitMutation();
    requestRender();
  }
}
for (const s of $$('.swatch')) {
  s.style.background = s.dataset.c;
  s.addEventListener('click', () => setColor(s.dataset.c));
}
$('#colorInput').addEventListener('input', e => setColor(e.target.value));

$('#widthRange').addEventListener('input', e => {
  style.width = Number(e.target.value);
  const d = Math.min(18, Math.max(3, style.width));
  $('#widthPreview').style.width = d + 'px';
  $('#widthPreview').style.height = d + 'px';
});

for (const b of $$('#optFill button')) {
  b.addEventListener('click', () => {
    style.fill = b.dataset.fill;
    for (const o of $$('#optFill button')) o.classList.toggle('on', o === b);
    if (sel >= 0 && ann[sel] && (ann[sel].type === 'rect' || ann[sel].type === 'ellipse')) {
      beginMutation();
      ann[sel].fill = style.fill;
      commitMutation();
      requestRender();
    }
  });
}

$('#fontRange').addEventListener('input', e => {
  style.fontSize = Number(e.target.value);
  $('#fontValue').textContent = style.fontSize;
  if (textState) textEdit.style.fontSize = style.fontSize * zoom + 'px';
});

// ---------------------------------------------------------------- zoom / pan
viewport.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) {
    const rect = view.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.13 : 1 / 1.13;
    setZoom(zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
  } else {
    panX -= e.shiftKey ? e.deltaY : e.deltaX;
    panY -= e.shiftKey ? 0 : e.deltaY;
    requestRender();
  }
}, { passive: false });

$('#zIn').addEventListener('click', () => setZoom(zoom * 1.25));
$('#zOut').addEventListener('click', () => setZoom(zoom / 1.25));
$('#zFit').addEventListener('click', fitView);

// ---------------------------------------------------------------- export
function compose() {
  const out = document.createElement('canvas');
  out.width = iw(); out.height = ih();
  const c = out.getContext('2d');
  c.drawImage(base(), 0, 0);
  for (const a of ann) drawAnn(c, a, base());
  return out.toDataURL('image/png');
}

async function doSave() {
  if (!doc) return;
  const res = await ipcRenderer.invoke('editor:save', { path: doc.path, dataURL: compose() });
  if (res.ok) { setDirty(false); toast('Saved'); }
  else toast('Save failed');
}
async function doSaveAs() {
  if (!doc) return;
  const res = await ipcRenderer.invoke('editor:saveas', { dataURL: compose(), name: doc.name });
  if (res.ok) toast('Saved copy');
}
function doCopy() {
  if (!doc) return;
  ipcRenderer.send('editor:copy', { dataURL: compose() });
  toast('Copied to clipboard');
}
$('#btnSave').addEventListener('click', doSave);
$('#btnSaveAs').addEventListener('click', doSaveAs);
$('#btnCopy').addEventListener('click', doCopy);

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', e => {
  if (textState) return; // text editor handles its own keys
  const k = e.key.toLowerCase();
  if (e.ctrlKey) {
    if (k === 'z') { e.preventDefault(); undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); e.shiftKey ? doSaveAs() : doSave(); }
    else if (k === 'c') { e.preventDefault(); doCopy(); }
    else if (k === '=' || k === '+') { e.preventDefault(); setZoom(zoom * 1.25); }
    else if (k === '-') { e.preventDefault(); setZoom(zoom / 1.25); }
    else if (k === '0') { e.preventDefault(); fitView(); }
    return;
  }
  if (k === ' ') { spaceHeld = true; view.classList.add('pan-cursor'); e.preventDefault(); return; }
  const toolKeys = { v: 'select', p: 'pen', h: 'highlighter', l: 'line', a: 'arrow', r: 'rect', e: 'ellipse', t: 'text', s: 'step', b: 'blur', c: 'crop' };
  if (toolKeys[k]) { setTool(toolKeys[k]); return; }
  if (k === '0') { fitView(); return; }
  if (k === 'enter' && tool === 'crop' && crop) { applyCrop(); return; }
  if (k === 'escape') {
    if (tool === 'crop' && crop) cancelCrop();
    else if (sel >= 0) { sel = -1; requestRender(); }
    return;
  }
  if ((k === 'delete' || k === 'backspace') && sel >= 0) {
    beginMutation();
    ann.splice(sel, 1);
    sel = -1;
    commitMutation();
    requestRender();
  }
});
window.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceHeld = false; view.classList.remove('pan-cursor'); }
});

// ---------------------------------------------------------------- load
ipcRenderer.on('editor:load', (e, payload) => {
  doc = { path: payload.path, name: payload.name };
  $('#docNameText').textContent = payload.name;
  document.title = `TerminalShot Editor — ${payload.name}`;
  ann = [];
  undoStack = [];
  redoStack = [];
  sel = -1;
  crop = null;
  stepCount = 0;
  cancelText();
  cropBar.classList.remove('show');
  setDirty(false);
  setTool('select');
  $('#dropHint').style.display = 'flex';
  $('#dropHint').textContent = 'Loading…';
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    bases = [c];
    baseIdx = 0;
    $('#dropHint').style.display = 'none';
    fitView();
  };
  img.onerror = () => { $('#dropHint').textContent = 'Could not load image'; };
  img.src = payload.url;
});

window.addEventListener('resize', () => { requestRender(); });
new ResizeObserver(() => requestRender()).observe(viewport);

// init defaults
setColor('#ff5470');
setTool('select');
$('#widthPreview').style.width = '5px';
$('#widthPreview').style.height = '5px';

// ---------------------------------------------------------------- test hooks
window.__fsEd = {
  state: () => ({ ann: ann.length, undo: undoStack.length, redo: redoStack.length, tool, zoom, iw: iw(), ih: ih(), sel, dirty }),
  setTool,
  addText: (x, y, text) => { beginMutation(); ann.push({ type: 'text', x, y, text, size: style.fontSize, color: style.color }); commitMutation(); requestRender(); },
  setCrop: r => { setTool('crop'); crop = { ...r }; cropBar.classList.add('show'); requestRender(); },
  applyCrop,
  undo,
  redo,
  compose,
};
