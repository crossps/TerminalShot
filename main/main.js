'use strict';
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain,
  screen, clipboard, nativeImage, dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { captureDisplay, listWindows } = require('./capture');
const { ScrollSession, AutoScrollSession } = require('./scrollcap');
const W = require('./windows');

const TEST = process.env.TERMINALSHOT_TEST === '1';
const ICON_TRAY = path.join(__dirname, '..', 'assets', 'icon-32.png');

let tray = null;
let frozen = null;            // { image, ratio, display } — frozen screen for area/scroll select
let scroll = null;            // { session, display, ratio, rect }
let pickerImages = new Map(); // id -> full-res NativeImage for the window picker
let hotkeyStatus = {};
let busy = false;

const delay = ms => new Promise(r => setTimeout(r, ms));
const fileUrl = p => 'file:///' + p.replace(/\\/g, '/');

// ---------------------------------------------------------------- lifecycle
if (!TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const l = W.get('launcher');
    if (l) { W.positionLauncher(); l.show(); l.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.crossps.terminalshot');
    store.init(app);
    W.init();
    createTray();
    registerHotkeys();
    wireIpc();
    const l = W.get('launcher');
    l.once('ready-to-show', () => {
      W.positionLauncher();
      l.show();
      l.webContents.send('launcher:reveal');
    });
    if (TEST) setupTestHooks();
  });

  app.on('window-all-closed', () => { /* tray app — keep running */ });
  app.on('before-quit', () => { W.setQuitting(true); globalShortcut.unregisterAll(); });
}

// ---------------------------------------------------------------- tray & hotkeys
function createTray() {
  tray = new Tray(ICON_TRAY);
  tray.setToolTip('TerminalShot — screenshots, finished');
  const hk = store.get().hotkeys;
  const accel = a => a.replace(/Control/g, 'Ctrl');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Full page (auto-scroll)', accelerator: accel(hk.page), click: () => startCapture('page') },
    { label: 'Capture area', accelerator: accel(hk.area), click: () => startCapture('area') },
    { label: 'Capture window', accelerator: accel(hk.window), click: () => startCapture('window') },
    { label: 'Capture full screen', accelerator: accel(hk.full), click: () => startCapture('full') },
    { label: 'Scrolling capture', accelerator: accel(hk.scroll), click: () => startCapture('scroll') },
    { type: 'separator' },
    { label: 'Open captures folder', click: () => shell.openPath(store.get().savePath) },
    { label: 'Show TerminalShot', click: showLauncher },
    { type: 'separator' },
    { label: 'Quit TerminalShot', click: () => app.quit() },
  ]));
  tray.on('click', showLauncher);
}

function showLauncher() {
  const l = W.get('launcher');
  if (!l) return;
  if (l.isVisible()) { l.hide(); return; }
  W.positionLauncher();
  l.show();
  l.focus();
  l.webContents.send('launcher:reveal');
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyStatus = {};
  const hk = store.get().hotkeys;
  for (const [mode, accel] of Object.entries(hk)) {
    try {
      hotkeyStatus[mode] = globalShortcut.register(accel, () => startCapture(mode));
    } catch {
      hotkeyStatus[mode] = false;
    }
  }
}

// ---------------------------------------------------------------- capture flow
async function startCapture(mode) {
  // pressing a scroll-mode hotkey while a session runs = finish it
  if (scroll) {
    if (mode === 'scroll' || mode === 'page') finishScroll();
    return;
  }
  if (busy) return;
  busy = true;
  try {
    W.hideCaptureUi();
    await delay(180); // let our windows leave the compositor before freezing
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    if (mode === 'full') {
      const { image } = await captureDisplay(display);
      finishCapture(image);
    } else if (mode === 'window') {
      await openPicker(display);
    } else if (mode === 'area' || mode === 'scroll' || mode === 'page') {
      const { image, ratio } = await captureDisplay(display);
      frozen = { image, ratio, display, mode };
      const tmp = path.join(app.getPath('temp'), 'terminalshot-frozen.png');
      fs.writeFileSync(tmp, image.toPNG());
      const o = W.get('overlay');
      o.setBounds(display.bounds);
      const size = image.getSize();
      o.webContents.send('overlay:begin', {
        mode,
        url: fileUrl(tmp) + '?t=' + Date.now(),
        iw: size.width, ih: size.height,
      });
      // overlay renderer answers 'overlay:ready' once the image is painted
    }
  } catch (err) {
    console.error('capture failed:', err);
  } finally {
    busy = false;
  }
}

async function openPicker(display) {
  const sources = await listWindows(W.ownSourceIds());
  pickerImages = new Map();
  const items = sources.map(s => {
    pickerImages.set(s.id, s.thumbnail);
    return {
      id: s.id,
      name: s.name,
      thumb: s.thumbnail.resize({ width: 420 }).toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    };
  });
  const p = W.get('picker');
  const wa = display.workArea;
  const [pw, ph] = p.getSize();
  p.setPosition(wa.x + Math.round((wa.width - pw) / 2), wa.y + Math.round((wa.height - ph) / 2));
  p.webContents.send('picker:data', { items });
  p.show();
  p.focus();
}

// rect arrives in image (device) pixels
function onOverlayDone(rect, mode) {
  const o = W.get('overlay');
  if (!frozen) { o.hide(); return; }
  if (mode === 'area') {
    const img = frozen.image.crop(rect);
    o.hide();
    frozen = null;
    finishCapture(img);
  } else if (mode === 'scroll' || mode === 'page') {
    beginScrollSession(frozen.display, frozen.ratio, rect, mode === 'page');
  }
}

function beginScrollSession(display, ratio, rect, auto = false) {
  if (scroll) return; // one session at a time (evaluate retries must not double-start)
  const o = W.get('overlay');
  const ctl = W.get('scrollctl');
  frozen = null;

  const b = display.bounds, wa = display.workArea;
  const [cw, chh] = ctl.getSize();
  let cssRect = {
    x: rect.x / ratio, y: rect.y / ratio,
    w: rect.width / ratio, h: rect.height / ratio,
  };

  // control bar placement: below the frame → above it → dock inside the top
  // edge and shrink the capture region below the bar so it is never recorded
  let cx = Math.round(b.x + cssRect.x + cssRect.w / 2 - cw / 2);
  cx = Math.max(wa.x + 8, Math.min(cx, wa.x + wa.width - cw - 8));
  const below = Math.round(b.y + cssRect.y + cssRect.h + 16);
  const above = Math.round(b.y + cssRect.y - chh - 16);
  let cy;
  if (below + chh <= wa.y + wa.height - 6) {
    cy = below;
  } else if (above >= wa.y + 6) {
    cy = above;
  } else {
    cy = Math.round(b.y + cssRect.y + 8);
    const cut = Math.round(Math.min(chh + 22, cssRect.h * 0.4) * ratio);
    rect = { ...rect, y: rect.y + cut, height: rect.height - cut };
    cssRect = {
      x: rect.x / ratio, y: rect.y / ratio,
      w: rect.width / ratio, h: rect.height / ratio,
    };
  }

  // overlay becomes a click-through accent frame around the recorded region,
  // dropped to 'floating' level so the control bar always stacks above it
  o.webContents.send('overlay:frame', { rect: cssRect });
  o.setIgnoreMouseEvents(true);
  o.setAlwaysOnTop(true, 'floating');
  ctl.setPosition(cx, cy);

  const hooks = {
    onStatus: st => {
      const c = W.get('scrollctl');
      if (c && c.isVisible()) c.webContents.send('scroll:status', st);
      if (st.full && !auto) finishScroll();
    },
    onAutoDone: () => finishScroll(),
  };
  const session = auto
    ? new AutoScrollSession(display, rect, ratio, hooks)
    : new ScrollSession(display, rect, hooks);
  scroll = { session, display, ratio, rect, auto };
  ctl.webContents.send('scroll:begin', { auto });
  ctl.showInactive();
  ctl.moveTop();
  session.start();
}

function endScrollUi() {
  const o = W.get('overlay');
  const ctl = W.get('scrollctl');
  if (ctl) ctl.hide();
  if (o) {
    o.setIgnoreMouseEvents(false);
    o.setAlwaysOnTop(true, 'screen-saver');
    o.hide();
  }
}

function finishScroll() {
  if (!scroll) return;
  const img = scroll.session.stop();
  scroll = null;
  endScrollUi();
  if (img) finishCapture(img);
}

function cancelScroll() {
  if (!scroll) return;
  scroll.session.cancel();
  scroll = null;
  endScrollUi();
}

let lastCapturePath = null;
function finishCapture(img) {
  const size = img.getSize();
  if (!size.width || !size.height) return;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
  const file = path.join(store.get().savePath, `TerminalShot_${stamp}.png`);
  fs.writeFileSync(file, img.toPNG());
  lastCapturePath = file;
  if (store.get().autoCopy) clipboard.writeImage(img);
  const preview = size.width > 640 ? img.resize({ width: 640 }) : img;
  W.showThumb({
    path: file,
    dataURL: preview.toDataURL(),
    w: size.width, h: size.height,
    seconds: store.get().thumbSeconds,
  });
  const l = W.get('launcher');
  if (l) l.webContents.send('recents:changed');
}

function openEditor(filePath) {
  const e = W.get('editor');
  if (!e) return;
  e.webContents.send('editor:load', {
    path: filePath,
    name: path.basename(filePath),
    url: fileUrl(filePath) + '?t=' + Date.now(),
  });
  if (e.isMinimized()) e.restore();
  e.show();
  e.focus();
}

function listRecents(n = 12) {
  const dir = store.get().savePath;
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.png$/i.test(f))
      .map(f => {
        const p = path.join(dir, f);
        const time = fs.statSync(p).mtimeMs;
        return { name: f, path: p, url: fileUrl(p) + '?t=' + Math.round(time), time };
      })
      .sort((a, b) => b.time - a.time)
      .slice(0, n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- ipc
function wireIpc() {
  ipcMain.on('ui:mode', (e, { mode }) => startCapture(mode));

  ipcMain.on('overlay:ready', () => {
    const o = W.get('overlay');
    if (!o || !frozen) return;
    o.setAlwaysOnTop(true, 'screen-saver');
    o.show();
    o.focus();
  });
  ipcMain.on('overlay:done', (e, { rect, mode }) => onOverlayDone(rect, mode));
  ipcMain.on('overlay:cancel', () => {
    const o = W.get('overlay');
    frozen = null;
    if (o) o.hide();
  });

  ipcMain.on('picker:pick', (e, { id }) => {
    const img = pickerImages.get(id);
    const p = W.get('picker');
    if (p) p.hide();
    pickerImages = new Map();
    if (img) finishCapture(img);
  });
  ipcMain.on('picker:cancel', () => {
    const p = W.get('picker');
    pickerImages = new Map();
    if (p) p.hide();
  });
  ipcMain.on('picker:refresh', async () => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const p = W.get('picker');
    if (p) p.hide();
    await delay(160);
    openPicker(display);
  });

  ipcMain.on('scroll:stop', () => finishScroll());
  ipcMain.on('scroll:cancel', () => cancelScroll());

  ipcMain.on('thumb:drag', (e, { path: p }) => {
    try {
      const icon = nativeImage.createFromPath(p).resize({ width: 96 });
      e.sender.startDrag({ file: p, icon });
    } catch (err) {
      console.error('drag failed:', err);
    }
  });
  ipcMain.on('thumb:action', async (e, { action, path: p }) => {
    const t = W.get('thumb');
    if (action === 'edit') { if (t) t.hide(); openEditor(p); }
    else if (action === 'copy') { clipboard.writeImage(nativeImage.createFromPath(p)); }
    else if (action === 'folder') { shell.showItemInFolder(p); }
    else if (action === 'close') { if (t) t.hide(); }
    else if (action === 'saveas') {
      const res = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('pictures'), path.basename(p)),
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (!res.canceled && res.filePath) fs.copyFileSync(p, res.filePath);
    }
  });

  ipcMain.handle('editor:save', (e, { path: p, dataURL }) => {
    try {
      fs.writeFileSync(p, Buffer.from(dataURL.split(',')[1], 'base64'));
      const l = W.get('launcher');
      if (l) l.webContents.send('recents:changed');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle('editor:saveas', async (e, { dataURL, name }) => {
    const res = await dialog.showSaveDialog({
      defaultPath: path.join(store.get().savePath, name || 'TerminalShot.png'),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, Buffer.from(dataURL.split(',')[1], 'base64'));
    return { ok: true, path: res.filePath };
  });
  ipcMain.on('editor:copy', (e, { dataURL }) => {
    clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
  });

  ipcMain.handle('settings:get', () => ({ settings: store.get(), hotkeyStatus }));
  ipcMain.handle('settings:set', (e, patch) => {
    const before = JSON.stringify(store.get().hotkeys);
    const s = store.set(patch);
    if (JSON.stringify(s.hotkeys) !== before) { registerHotkeys(); createTray(); }
    return { settings: s, hotkeyStatus };
  });
  ipcMain.handle('settings:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      defaultPath: store.get().savePath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const s = store.set({ savePath: res.filePaths[0] });
    return { ok: true, settings: s };
  });

  ipcMain.handle('recents:get', () => listRecents());
  ipcMain.on('recents:open', (e, { path: p }) => openEditor(p));
  ipcMain.on('shell:openCaptures', () => shell.openPath(store.get().savePath));
  ipcMain.on('shell:showItem', (e, { path: p }) => shell.showItemInFolder(p));

  ipcMain.on('win:op', (e, { op }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (op === 'min') w.minimize();
    else if (op === 'max') w.isMaximized() ? w.unmaximize() : w.maximize();
    else if (op === 'hide') w.hide();
    else if (op === 'close') w.close();
  });
  ipcMain.on('app:quit', () => app.quit());
}

// ---------------------------------------------------------------- test hooks
function setupTestHooks() {
  // Kept as __fstest for compatibility with the existing verification harness.
  global.__fstest = {
    startCapture,
    finishScroll,
    cancelScroll,
    beginScroll: rect => {
      const display = screen.getPrimaryDisplay();
      beginScrollSession(display, display.scaleFactor, rect);
    },
    beginAutoScroll: rect => {
      const display = screen.getPrimaryDisplay();
      beginScrollSession(display, display.scaleFactor, rect, true);
    },
    state: () => ({
      capturesDir: store.get().savePath,
      last: lastCapturePath,
      scrolling: !!scroll,
      scrollRect: scroll ? scroll.rect : null,
      autoTrace: global.__autoTrace || null,
      autoError: global.__lastAutoError || null,
      hotkeyStatus,
    }),
    windows: name => {
      const w = W.get(name);
      return w ? { visible: w.isVisible(), bounds: w.getBounds() } : null;
    },
    wheel: () => {
      try {
        const wheel = require('./wheel');
        return { available: wheel.available(), posted: wheel.available() ? wheel.wheelAt(300, 300, 0) : null };
      } catch (err) {
        return { error: String(err && err.stack || err) };
      }
    },
    openEditor,
    showLauncher,
    dataLocation: () => store.location(),
    makeDocFixture: async filePath => {
      const demo = new BrowserWindow({
        show: false,
        width: 1200,
        height: 720,
        frame: false,
        backgroundColor: '#080a11',
        webPreferences: { backgroundThrottling: false },
      });
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box}body{margin:0;width:1200px;height:720px;overflow:hidden;background:radial-gradient(circle at 75% 15%,#18335a 0,#0b1220 28%,#070910 70%);color:#e9ecf6;font-family:Segoe UI,Arial,sans-serif}
        main{padding:54px 62px}.eyebrow{color:#7cdeff;font:600 13px/1.2 Consolas,monospace;letter-spacing:.18em;text-transform:uppercase}.top{display:flex;align-items:flex-end;justify-content:space-between;margin:14px 0 34px}h1{font-size:52px;line-height:1;margin:0;letter-spacing:-.045em}.status{border:1px solid #275444;background:#0c251f;color:#75efbb;padding:9px 14px;border-radius:999px;font-weight:650}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:22px}.card{border:1px solid #26334d;background:rgba(11,15,25,.88);border-radius:18px;padding:24px;box-shadow:0 22px 60px #0005}.card h2{font-size:16px;margin:0 0 20px;color:#aab5cc}.checks{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{border:1px solid #25334e;background:#0a0f19;border-radius:13px;padding:18px}.metric strong{display:block;font-size:29px;color:#fff}.metric span{font-size:12px;color:#8090aa}.list{margin-top:18px;display:grid;gap:11px}.row{display:flex;gap:12px;align-items:center;color:#c8d0df}.tick{width:21px;height:21px;border-radius:7px;background:#173b31;color:#66efb5;text-align:center;line-height:21px}.code{font:14px/1.75 Consolas,monospace;color:#9db0cb}.code b{color:#76e8ff}.code em{color:#73e4ad;font-style:normal}.footer{position:absolute;left:62px;right:62px;bottom:38px;display:flex;justify-content:space-between;color:#68758e;font-size:13px}.brand{color:#e9ecf6;font-weight:650}
      </style></head><body><main><div class="eyebrow">TerminalShot · Release desk</div><div class="top"><h1>Ready to ship.</h1><div class="status">All checks passed</div></div><div class="grid"><section class="card"><h2>Verification summary</h2><div class="checks"><div class="metric"><strong>60</strong><span>automated checks</span></div><div class="metric"><strong>5</strong><span>capture modes</span></div><div class="metric"><strong>0</strong><span>renderer errors</span></div></div><div class="list"><div class="row"><span class="tick">✓</span>Full-page stitching verified with static sidebars</div><div class="row"><span class="tick">✓</span>Pixel-precise area magnifier inspected</div><div class="row"><span class="tick">✓</span>Vector annotations, crop, undo and export verified</div></div></section><section class="card"><h2>Release output</h2><div class="code"><b>PS&gt;</b> npm run verify<br><em>PASS</em> stitcher / exact + fuzzy<br><em>PASS</em> capture / full + area<br><em>PASS</em> editor / vectors + crop<br><br><b>PS&gt;</b> npm run dist<br>TerminalShot-1.0.0-windows-x64.exe</div></section></div></main><div class="footer"><span class="brand">TerminalShot</span><span>Capture precisely. Mark it up. Send it.</span></div></body></html>`;
      try {
        await demo.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await delay(180);
        const image = await demo.webContents.capturePage();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, image.toPNG());
        return filePath;
      } finally {
        if (!demo.isDestroyed()) demo.destroy();
      }
    },
  };
}
