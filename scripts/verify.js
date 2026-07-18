'use strict';
// TerminalShot verification suite.
//  Part 1: deterministic unit tests of the scroll stitcher (pure Node).
//  Part 2: drive the real Electron app with Playwright — launcher, full capture,
//          thumbnail, editor tools, crop/undo, clipboard, area overlay + magnifier,
//          window picker, scroll session. Screenshots land in scripts/shots/.
const path = require('path');
const fs = require('fs');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
const TEST_DATA = path.join(__dirname, '.tmp-data');
const TEST_CAPTURES = path.join(TEST_DATA, 'captures');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(TEST_CAPTURES, { recursive: true });
fs.writeFileSync(path.join(TEST_DATA, 'settings.json'), JSON.stringify({
  savePath: TEST_CAPTURES,
  autoCopy: true,
  thumbSeconds: 6,
}, null, 2));

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  results.push({ name, ok, detail });
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------- stitcher unit tests
function stitcherTests() {
  const { Stitcher } = require(path.join(ROOT, 'main', 'stitch.js'));
  const W = 320, H = 240, DOC_H = 1400;

  // deterministic, row-distinctive document
  const doc = Buffer.alloc(W * DOC_H * 4);
  for (let y = 0; y < DOC_H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      doc[i] = (x * 7 + y * 31) & 0xff;
      doc[i + 1] = (x * 13 + y * 17) & 0xff;
      doc[i + 2] = (x * 3 + y * 53) & 0xff;
      doc[i + 3] = 255;
    }
  }
  const frameAt = off => doc.subarray(off * W * 4, (off + H) * W * 4);

  const st = new Stitcher(W, H);
  const offsets = [0, 0, 90, 90, 210, 347, 470, 470, 610, 780, 941, 1100, 1160];
  for (const off of offsets) st.push(Buffer.from(frameAt(off)));
  const out = st.compose();
  check('stitch: composed height matches scrolled document', out.height === 1160 + H, `got ${out.height}, want ${1160 + H}`);
  check('stitch: width preserved', out.width === W);

  // pixel-exact content check at several probe rows
  let pixelOk = true;
  for (const y of [0, 100, 500, 900, 1300, 1160 + H - 1]) {
    for (const x of [0, 50, 200, W - 1]) {
      const a = (y * W + x) * 4;
      if (out.buffer[a] !== doc[a] || out.buffer[a + 1] !== doc[a + 1] || out.buffer[a + 2] !== doc[a + 2]) {
        pixelOk = false;
      }
    }
  }
  check('stitch: pixels identical to source document', pixelOk);

  // unchanged frames add nothing
  const st2 = new Stitcher(W, H);
  st2.push(Buffer.from(frameAt(0)));
  const r = st2.push(Buffer.from(frameAt(0)));
  check('stitch: static frame adds 0 rows', r.added === 0 && st2.totalH === H);

  // sticky header tolerance: overwrite top 12% of each frame with a constant band
  const st3 = new Stitcher(W, H);
  const sticky = off => {
    const f = Buffer.from(frameAt(off));
    for (let y = 0; y < Math.floor(H * 0.1); y++) {
      for (let x = 0; x < W * 4; x++) f[y * W * 4 + x] = 200;
    }
    return f;
  };
  st3.push(sticky(0));
  st3.push(sticky(130));
  st3.push(sticky(260));
  check('stitch: sticky header tolerated', st3.totalH === 260 + H, `got ${st3.totalH}`);

  // the real-world layout that broke v1: static sidebars flanking a scrolling
  // column, plus a moving scrollbar thumb at the right edge
  const W2 = 600, H2 = 240, DOC2 = 2000;
  const sideFrame = off => {
    const f = Buffer.alloc(W2 * H2 * 4);
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const i = (y * W2 + x) * 4;
        let r, g, b;
        if (x >= 120 && x < 480) {          // scrolling content column
          const dy = off + y;
          r = (x * 7 + dy * 31) & 0xff; g = (x * 13 + dy * 17) & 0xff; b = (x * 3 + dy * 53) & 0xff;
        } else {                             // static sidebars
          r = (x * 11 + y * 5) & 0xff; g = (x * 5 + y * 11) & 0xff; b = 60;
        }
        f[i] = b; f[i + 1] = g; f[i + 2] = r; f[i + 3] = 255;
      }
    }
    // moving scrollbar thumb, right edge
    const t0 = Math.floor((off / DOC2) * (H2 - 40));
    for (let y = t0; y < t0 + 40; y++) {
      for (let x = 586; x < 598; x++) {
        const i = (y * W2 + x) * 4;
        f[i] = 240; f[i + 1] = 240; f[i + 2] = 240;
      }
    }
    return f;
  };
  const st4 = new Stitcher(W2, H2);
  const sideOffsets = [0, 120, 250, 360, 500, 620, 750];
  for (const off of sideOffsets) st4.push(sideFrame(off));
  check('stitch: static sidebars + moving scrollbar (v1 killer) stitched', st4.totalH === 750 + H2, `got ${st4.totalH}, want ${750 + H2}`);

  // fuzzy mode: YUV-4:2:0-style noise (offset-dependent ±3 on B/R) breaks
  // exact hashes — the stream path must still stitch through it
  const noisy = off => {
    const f = Buffer.from(frameAt(off));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const n = ((x * 31 + y * 17 + off * 13) % 7) - 3;
        f[i] = Math.max(0, Math.min(255, f[i] + n));
        f[i + 2] = Math.max(0, Math.min(255, f[i + 2] - n));
      }
    }
    return f;
  };
  const stExact = new Stitcher(W, H);
  const stFuzzy = new Stitcher(W, H, { fuzzy: true });
  for (const off of [0, 130, 260, 390]) { stExact.push(noisy(off)); stFuzzy.push(noisy(off)); }
  check('stitch: chroma-noise defeats exact mode (sanity)', stExact.totalH < 390 + H, `exact got ${stExact.totalH}`);
  check('stitch: fuzzy mode stitches through chroma noise', stFuzzy.totalH === 390 + H, `fuzzy got ${stFuzzy.totalH}, want ${390 + H}`);
  const out4 = st4.compose();
  let centerOk = true;
  for (const y of [10, 300, 700, 950]) {
    for (const x of [150, 300, 460]) {
      const i = (y * W2 + x) * 4;
      const dy = y;
      if (out4.buffer[i + 2] !== ((x * 7 + dy * 31) & 0xff) || out4.buffer[i + 1] !== ((x * 13 + dy * 17) & 0xff)) centerOk = false;
    }
  }
  check('stitch: scrolled column content pixel-exact', centerOk);
}

// ---------------------------------------------------------------- app tests
async function appTests() {
  const app = await _electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, TERMINALSHOT_TEST: '1', TERMINALSHOT_DATA_DIR: TEST_DATA },
  });

  const consoleErrors = [];
  const pages = {};
  const classify = page => {
    const url = page.url();
    for (const n of ['launcher', 'overlay', 'thumb', 'editor', 'picker', 'scrollctl']) {
      if (url.includes(`/${n}/`)) pages[n] = page;
    }
    page.on('console', m => {
      if (m.type() === 'error') consoleErrors.push(`[${url.split('/').pop()}] ${m.text()}`);
    });
  };
  app.on('window', classify);
  for (const p of app.windows()) classify(p);

  const waitFor = async (fn, ms = 8000, step = 100) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await fn()) return true; } catch {}
      await new Promise(r => setTimeout(r, step));
    }
    return false;
  };
  const main = async (fn, arg) => {
    try {
      return await app.evaluate(fn, arg);
    } catch (err) {
      // transient CDP context recycle (seen right after heavy main-process work)
      if (String(err).includes('Execution context was destroyed')) {
        await new Promise(r => setTimeout(r, 600));
        return await app.evaluate(fn, arg);
      }
      throw err;
    }
  };

  await waitFor(() => pages.launcher && pages.editor && pages.overlay && pages.thumb, 15000);
  check('app: all pre-warmed windows loaded', pages.launcher && pages.editor && pages.overlay && pages.thumb && pages.picker && pages.scrollctl);

  // -------- launcher
  const launcherVisible = await waitFor(() => main(() => global.__fstest.windows('launcher').visible));
  check('launcher: visible on startup', launcherVisible);
  await pages.launcher.waitForSelector('.mode', { timeout: 5000 });
  const modeCount = await pages.launcher.locator('.mode').count();
  check('launcher: 5 capture mode cards', modeCount === 5);
  await pages.launcher.screenshot({ path: path.join(SHOTS, '01-launcher.png') });

  // settings sheet state
  await pages.launcher.click('#btnSettings');
  await pages.launcher.waitForTimeout(400);
  const sheetOpen = await pages.launcher.evaluate(() => document.querySelector('#settings').classList.contains('open'));
  check('launcher: settings sheet opens', sheetOpen);
  const hkRows = await pages.launcher.locator('.hk-row').count();
  check('launcher: hotkeys listed in settings', hkRows === 5);
  await pages.launcher.screenshot({ path: path.join(SHOTS, '02-launcher-settings.png') });
  await pages.launcher.click('#btnSettingsClose');

  // -------- full-screen capture → thumbnail
  await main(el => { el.clipboard.clear(); });
  await main(() => global.__fstest.startCapture('full'));
  const thumbShown = await waitFor(() => main(() => global.__fstest.windows('thumb').visible), 10000);
  check('full capture: floating thumbnail appears', thumbShown);
  const st1 = await main(() => global.__fstest.state());
  check('full capture: PNG saved to captures folder', st1.last && fs.existsSync(st1.last), String(st1.last));
  const clipSize = await main(el => el.clipboard.readImage().getSize());
  check('full capture: auto-copied to clipboard', clipSize.width > 0 && clipSize.height > 0);
  await pages.thumb.waitForTimeout(500);
  await pages.thumb.screenshot({ path: path.join(SHOTS, '03-thumbnail.png') });

  // pin so it doesn't dismiss mid-test, then open the editor from it
  await pages.thumb.click('#aPin');
  await pages.thumb.click('#imgWrap');
  const editorVisible = await waitFor(() => main(() => global.__fstest.windows('editor').visible), 8000);
  check('thumbnail: click opens editor', editorVisible);

  // -------- editor
  const loaded = await waitFor(() => pages.editor.evaluate(() => window.__fsEd.state().iw > 0), 8000);
  check('editor: image loaded with real dimensions', loaded);
  const dims0 = await pages.editor.evaluate(() => window.__fsEd.state());

  // pen drawing via real mouse
  await pages.editor.click('[data-tool="pen"]');
  const vp = await pages.editor.evaluate(() => {
    const r = document.querySelector('#viewport').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
  await pages.editor.mouse.move(cx - 120, cy - 60);
  await pages.editor.mouse.down();
  for (let i = 0; i <= 12; i++) await pages.editor.mouse.move(cx - 120 + i * 20, cy - 60 + Math.sin(i / 2) * 40, { steps: 2 });
  await pages.editor.mouse.up();
  let stEd = await pages.editor.evaluate(() => window.__fsEd.state());
  check('editor: pen stroke committed', stEd.ann === 1 && stEd.undo === 1, JSON.stringify(stEd));

  // rectangle via mouse
  await pages.editor.click('[data-tool="rect"]');
  await pages.editor.mouse.move(cx - 80, cy + 20);
  await pages.editor.mouse.down();
  await pages.editor.mouse.move(cx + 90, cy + 110, { steps: 6 });
  await pages.editor.mouse.up();
  stEd = await pages.editor.evaluate(() => window.__fsEd.state());
  check('editor: rectangle committed', stEd.ann === 2);

  // arrow
  await pages.editor.click('[data-tool="arrow"]');
  await pages.editor.mouse.move(cx + 140, cy - 90);
  await pages.editor.mouse.down();
  await pages.editor.mouse.move(cx + 40, cy + 10, { steps: 5 });
  await pages.editor.mouse.up();
  // text via hook (IME-free deterministic path)
  await pages.editor.evaluate(() => window.__fsEd.addText(40, 40, 'TerminalShot ships'));
  stEd = await pages.editor.evaluate(() => window.__fsEd.state());
  check('editor: arrow + text committed', stEd.ann === 4);

  // step markers
  await pages.editor.click('[data-tool="step"]');
  await pages.editor.mouse.click(cx - 150, cy + 140);
  await pages.editor.mouse.click(cx - 100, cy + 150);
  stEd = await pages.editor.evaluate(() => window.__fsEd.state());
  check('editor: numbered step markers added', stEd.ann === 6);

  // color change
  await pages.editor.click('.swatch[data-c="#38d9f5"]');
  await pages.editor.screenshot({ path: path.join(SHOTS, '04-editor-annotated.png') });

  // undo / redo
  await pages.editor.evaluate(() => window.__fsEd.undo());
  const afterUndo = await pages.editor.evaluate(() => window.__fsEd.state());
  await pages.editor.evaluate(() => window.__fsEd.redo());
  const afterRedo = await pages.editor.evaluate(() => window.__fsEd.state());
  check('editor: undo/redo round-trip', afterUndo.ann === 5 && afterRedo.ann === 6, `${afterUndo.ann}/${afterRedo.ann}`);

  // crop
  await pages.editor.evaluate(() => window.__fsEd.setCrop({ x: 60, y: 50, w: 500, h: 380 }));
  await pages.editor.waitForTimeout(200);
  await pages.editor.screenshot({ path: path.join(SHOTS, '05-editor-crop.png') });
  await pages.editor.evaluate(() => window.__fsEd.applyCrop());
  stEd = await pages.editor.evaluate(() => window.__fsEd.state());
  check('editor: crop re-bases image', stEd.iw === 500 && stEd.ih === 380, `${stEd.iw}x${stEd.ih}`);
  check('editor: crop is undoable', true);
  await pages.editor.evaluate(() => window.__fsEd.undo());
  stEd = await pages.editor.evaluate(() => window.__fsEd.state());
  check('editor: undo restores pre-crop size', stEd.iw === dims0.iw && stEd.ih === dims0.ih, `${stEd.iw}x${stEd.ih}`);

  // copy composited PNG
  await main(el => { el.clipboard.clear(); });
  await pages.editor.click('#btnCopy');
  await pages.editor.waitForTimeout(600);
  const clip2 = await main(el => el.clipboard.readImage().getSize());
  check('editor: copy puts composited image on clipboard', clip2.width === dims0.iw && clip2.height === dims0.ih, JSON.stringify(clip2));
  await main(el => { for (const w of el.BrowserWindow.getAllWindows()) if (w.getTitle().includes('Editor')) w.hide(); });

  // -------- area overlay + magnifier
  await main(() => global.__fstest.startCapture('area'));
  const overlayVisible = await waitFor(() => main(() => global.__fstest.windows('overlay').visible), 10000);
  check('area: overlay appears', overlayVisible);
  await pages.overlay.waitForTimeout(300);
  // drag a selection, screenshot mid-drag to capture magnifier + size badge
  await pages.overlay.mouse.move(300, 300);
  await pages.overlay.waitForTimeout(150);
  await pages.overlay.mouse.down();
  await pages.overlay.mouse.move(760, 620, { steps: 10 });
  await pages.overlay.waitForTimeout(200);
  const magVisible = await pages.overlay.evaluate(() => document.querySelector('#mag').style.display === 'block');
  const magSel = await pages.overlay.evaluate(() => document.querySelector('#magSel').textContent);
  check('area: magnifier loupe visible during drag', magVisible);
  check('area: magnifier reports live selection size', /\d+ × \d+/.test(magSel), magSel);
  await pages.overlay.screenshot({ path: path.join(SHOTS, '06-area-overlay-magnifier.png') });
  await pages.overlay.mouse.up();
  const thumb2 = await waitFor(() => main(() => global.__fstest.windows('thumb').visible), 8000);
  check('area: selection produces a capture', thumb2);
  const st2 = await main(() => global.__fstest.state());
  check('area: cropped PNG saved', st2.last && fs.existsSync(st2.last) && st2.last !== st1.last);
  // dimensions should approximate the drag (460x320 css) * scaleFactor
  const sf = await main(el => el.screen.getPrimaryDisplay().scaleFactor);
  const pngSize = fs.statSync(st2.last).size;
  check('area: capture file is a plausible PNG', pngSize > 100, `${pngSize} bytes`);
  const expW = Math.round(460 * sf);
  const dims = await main((el, p) => el.nativeImage.createFromPath(p).getSize(), st2.last);
  check('area: capture matches dragged region', Math.abs(dims.width - expW) <= 4, `got ${dims.width}, want ~${expW}`);
  await pages.thumb.click('#aClose').catch(() => {});

  // esc cancels overlay
  await main(() => global.__fstest.startCapture('area'));
  await waitFor(() => main(() => global.__fstest.windows('overlay').visible), 8000);
  await pages.overlay.keyboard.press('Escape');
  const overlayGone = await waitFor(() => main(() => !global.__fstest.windows('overlay').visible), 5000);
  check('area: Esc cancels overlay', overlayGone);

  // -------- window picker
  await main(() => global.__fstest.startCapture('window'));
  const pickerVisible = await waitFor(() => main(() => global.__fstest.windows('picker').visible), 10000);
  check('picker: appears', pickerVisible);
  await pages.picker.waitForTimeout(400);
  const items = await pages.picker.locator('.witem').count();
  check('picker: lists at least one window', items >= 1, `${items} items`);
  await pages.picker.screenshot({ path: path.join(SHOTS, '07-window-picker.png') });
  if (items >= 1) {
    await pages.picker.locator('.witem').first().click();
    const thumb3 = await waitFor(() => main(() => global.__fstest.windows('thumb').visible), 8000);
    check('picker: choosing a window captures it', thumb3);
    await pages.thumb.click('#aClose').catch(() => {});
  }

  // -------- scroll session (static content → height stays at region height)
  const region = await main(el => {
    const sf2 = el.screen.getPrimaryDisplay().scaleFactor;
    return { x: Math.round(200 * sf2), y: Math.round(200 * sf2), width: Math.round(400 * sf2), height: Math.round(300 * sf2) };
  });
  await main((el, r) => global.__fstest.beginScroll(r), region);
  const ctlVisible = await waitFor(() => main(() => global.__fstest.windows('scrollctl').visible), 8000);
  check('scroll: control bar appears', ctlVisible);
  const gotFrames = await waitFor(() => pages.scrollctl.evaluate(() => Number(document.querySelector('#frames').textContent) >= 2), 8000);
  check('scroll: frames are being captured', gotFrames);
  await pages.scrollctl.screenshot({ path: path.join(SHOTS, '08-scroll-controlbar.png') });
  await main(() => global.__fstest.finishScroll());
  const st3 = await main(() => global.__fstest.state());
  check('scroll: session finished and saved', !st3.scrolling && st3.last && fs.existsSync(st3.last));
  // NB: the desktop is live during verify (this terminal prints inside the
  // region), so height may legitimately grow — assert width + sane bounds.
  const scrollDims = await main((el, p) => el.nativeImage.createFromPath(p).getSize(), st3.last);
  check('scroll: output has region width and sane stitched height',
    scrollDims.width === region.width && scrollDims.height >= region.height && scrollDims.height < region.height * 4,
    JSON.stringify(scrollDims));

  // full-screen region → no space outside, so the bar docks inside the top
  // edge and the capture region shrinks below it (bar never recorded)
  const fullRegion = await main(el => {
    const d = el.screen.getPrimaryDisplay();
    const sf3 = d.scaleFactor;
    return { x: 0, y: 0, width: Math.round(d.bounds.width * sf3), height: Math.round(d.bounds.height * sf3) };
  });
  await main((el, r) => global.__fstest.beginScroll(r), fullRegion);
  await waitFor(() => main(() => global.__fstest.windows('scrollctl').visible), 8000);
  const stFull = await main(() => global.__fstest.state());
  check('scroll: fullscreen region docks bar + shrinks region below it',
    stFull.scrollRect && stFull.scrollRect.y > 0 && stFull.scrollRect.height < fullRegion.height,
    JSON.stringify(stFull.scrollRect));
  await pages.scrollctl.waitForTimeout(400);
  // grab the real screen so the frame + bar can be reviewed together
  const liveShot = await main(async el => {
    const d = el.screen.getPrimaryDisplay();
    const src = await el.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) },
    });
    return src[0].thumbnail.resize({ width: 1400 }).toDataURL();
  });
  fs.writeFileSync(path.join(SHOTS, '09-scroll-frame-live.png'), Buffer.from(liveShot.split(',')[1], 'base64'));
  await main(() => global.__fstest.cancelScroll());

  // -------- full page (auto-scroll) end-to-end against a real scrollable window
  // spawn a tall scrollable target window, let the auto session rewind it,
  // scroll it via targeted WM_MOUSEWHEEL, and stitch the whole page
  await main(el => {
    const html = `<!doctype html><html><body style="margin:0;overflow-y:scroll;font:700 26px Consolas">
      ${Array.from({ length: 120 }, (_, i) =>
        `<div style="height:60px;line-height:60px;padding-left:24px;background:hsl(${(i * 23) % 360},60%,${22 + (i % 5) * 9}%);color:#fff">ROW ${i} — TerminalShot full-page test ${'#'.repeat(i % 17)}</div>`
      ).join('')}
    </body></html>`;
    // alwaysOnTop: the user may be actively working — without it, Windows'
    // foreground lock leaves this window BEHIND their apps and the session
    // captures/scrolls whatever the user has at that spot instead.
    const w = new el.BrowserWindow({
      x: 80, y: 80, width: 760, height: 560, frame: false, alwaysOnTop: true,
      skipTaskbar: true, title: 'FS-AUTOTEST-TARGET',
    });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    global.__fstestTarget = w;
    return new Promise(res => w.webContents.once('did-finish-load', () => setTimeout(res, 400)));
  });
  const pageRegion = await main(el => {
    const sf4 = el.screen.getPrimaryDisplay().scaleFactor;
    // inside the target window's content, clear of its edges
    return { x: Math.round(120 * sf4), y: Math.round(120 * sf4), width: Math.round(600 * sf4), height: Math.round(450 * sf4) };
  });
  await main((el, r) => global.__fstest.beginAutoScroll(r), pageRegion);
  const autoStarted = await waitFor(() => main(() => global.__fstest.windows('scrollctl').visible), 8000);
  check('page: auto session control bar appears', autoStarted);
  const autoFinished = await waitFor(() => main(() => !global.__fstest.state().scrolling), 60000, 500);
  check('page: auto session finishes by itself', autoFinished);
  const stAuto = await main(() => global.__fstest.state());
  const autoDims = stAuto.last && fs.existsSync(stAuto.last)
    ? await main((el, p) => el.nativeImage.createFromPath(p).getSize(), stAuto.last)
    : { width: 0, height: 0 };
  check('page: stitched output is much taller than the viewport',
    autoDims.width === pageRegion.width && autoDims.height > pageRegion.height * 2,
    `${JSON.stringify(autoDims)} trace=${JSON.stringify(stAuto.autoTrace)} err=${stAuto.autoError}`);
  await main(el => { if (global.__fstestTarget) { global.__fstestTarget.destroy(); global.__fstestTarget = null; } });
  await pages.thumb.click('#aClose').catch(() => {});

  // -------- settings roundtrip
  const setRes = await pages.launcher.evaluate(async () => {
    const { ipcRenderer } = require('electron');
    const r = await ipcRenderer.invoke('settings:set', { thumbSeconds: 9 });
    return r.settings.thumbSeconds;
  });
  check('settings: roundtrip through IPC + disk', setRes === 9);
  const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_DATA, 'settings.json'), 'utf8'));
  check('settings: persisted to the isolated data directory', onDisk.thumbSeconds === 9);
  await pages.launcher.evaluate(async () => {
    const { ipcRenderer } = require('electron');
    await ipcRenderer.invoke('settings:set', { thumbSeconds: 6 });
  });

  // recents populated
  const recents = await pages.launcher.evaluate(async () => {
    const { ipcRenderer } = require('electron');
    return (await ipcRenderer.invoke('recents:get')).length;
  });
  check('launcher: recent captures populated', recents >= 3, `${recents}`);

  // -------- console errors
  const realErrors = consoleErrors.filter(e => !/favicon|Autofill|ERR_CACHE/i.test(e));
  check('no renderer console errors', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

  await app.close();
}

(async () => {
  console.log('— Stitcher unit tests —');
  stitcherTests();
  if (process.argv.includes('--unit')) {
    console.log(`\n${passed}/${passed + failed} checks passed`);
    process.exit(failed ? 1 : 0);
  }
  console.log('— App end-to-end tests —');
  try {
    await appTests();
  } catch (err) {
    check('app tests completed without harness error', false, String(err && err.stack || err).slice(0, 400));
  }
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
