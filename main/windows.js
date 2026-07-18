'use strict';
// Window registry. Every window is created hidden at startup and reused
// (show/hide, never destroy) so each capture mode feels instant.
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const registry = {};
let quitting = false;

const ICON = path.join(__dirname, '..', 'assets', 'icon-256.png');
const R = f => path.join(__dirname, '..', 'renderer', f);

function baseWebPrefs() {
  return { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, spellcheck: false };
}

function create(name, file, opts) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    icon: ICON,
    ...opts,
    webPreferences: baseWebPrefs(),
  });
  win.loadFile(R(file));
  registry[name] = win;
  return win;
}

function init() {
  const launcher = create('launcher', 'launcher/launcher.html', {
    width: 424, height: 668, transparent: true, resizable: false, maximizable: false,
    fullscreenable: false, hasShadow: false, skipTaskbar: false, title: 'TerminalShot',
  });
  launcher.on('close', e => { if (!quitting) { e.preventDefault(); launcher.hide(); } });

  const overlay = create('overlay', 'overlay/overlay.html', {
    transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, hasShadow: false, skipTaskbar: true, focusable: true,
    enableLargerThanScreen: true, title: 'TerminalShot Overlay',
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');

  const thumb = create('thumb', 'thumb/thumb.html', {
    width: 372, height: 320, transparent: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, hasShadow: false, skipTaskbar: true,
    focusable: true, title: 'TerminalShot Capture',
  });
  thumb.setAlwaysOnTop(true, 'screen-saver');

  const editor = create('editor', 'editor/editor.html', {
    width: 1280, height: 840, minWidth: 1020, minHeight: 660,
    backgroundColor: '#0d0e14', resizable: true, maximizable: true,
    title: 'TerminalShot Editor',
  });
  editor.on('close', e => { if (!quitting) { e.preventDefault(); editor.hide(); } });

  const picker = create('picker', 'picker/picker.html', {
    width: 900, height: 640, transparent: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, hasShadow: false, skipTaskbar: true,
    title: 'TerminalShot Window Picker',
  });
  picker.setAlwaysOnTop(true, 'screen-saver');

  // hidden frame-grabber: holds a persistent screen stream during auto
  // sessions (a fresh desktopCapturer.getSources costs ~600 ms per call;
  // reading from a live stream costs ~20 ms)
  create('grabber', 'grabber/grabber.html', {
    width: 220, height: 140, skipTaskbar: true, focusable: false, title: 'TerminalShot Grabber',
  });

  const scrollctl = create('scrollctl', 'scrollctl/scrollctl.html', {
    width: 460, height: 92, transparent: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, hasShadow: false, skipTaskbar: true,
    focusable: true, title: 'TerminalShot Scroll Capture',
  });
  scrollctl.setAlwaysOnTop(true, 'screen-saver');
}

function get(name) {
  const w = registry[name];
  return w && !w.isDestroyed() ? w : null;
}

function ownSourceIds() {
  const ids = new Set();
  for (const name of Object.keys(registry)) {
    const w = get(name);
    if (!w) continue;
    try { ids.add(w.getMediaSourceId()); } catch {}
  }
  return ids;
}

function positionLauncher() {
  const l = get('launcher');
  if (!l) return;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w, h] = l.getSize();
  l.setPosition(wa.x + wa.width - w - 12, wa.y + wa.height - h - 12);
}

// Floating capture card, bottom-right of the active display.
function showThumb(payload) {
  const t = get('thumb');
  if (!t) return;
  const maxW = 300, maxH = 190;
  const scale = Math.min(maxW / payload.w, maxH / payload.h, 1);
  const cw = Math.max(170, Math.round(payload.w * scale));
  const ch = Math.max(64, Math.round(payload.h * scale));
  const winW = cw + 44, winH = ch + 106;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  t.setBounds({
    x: wa.x + wa.width - winW - 8,
    y: wa.y + wa.height - winH - 8,
    width: winW, height: winH,
  });
  t.webContents.send('thumb:show', { ...payload, cw, ch });
  t.showInactive();
}

function hideCaptureUi() {
  for (const n of ['launcher', 'thumb', 'picker']) {
    const w = get(n);
    if (w && w.isVisible()) w.hide();
  }
}

function setQuitting(v) { quitting = v; }

module.exports = { init, get, ownSourceIds, positionLauncher, showThumb, hideCaptureUi, setQuitting };
