'use strict';
// Scrolling-capture sessions.
//  ScrollSession      — manual: the user scrolls, we watch the region and stitch.
//  AutoScrollSession  — full page: we scroll the target window ourselves via
//                       targeted WM_MOUSEWHEEL (wheel.js), rewind to the top
//                       first, then capture until the bottom stops moving.
const { nativeImage, screen } = require('electron');
const { captureDisplay } = require('./capture');
const { Stitcher } = require('./stitch');
const wheel = require('./wheel');
const grab = require('./grab');

const delay = ms => new Promise(r => setTimeout(r, ms));

// Cheap sampled equality for "did anything change" checks during rewind.
function framesAlike(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const step = Math.max(4, (a.length >> 12) & ~3); // ~4096 samples, pixel-aligned
  let same = 0, total = 0;
  for (let i = 0; i < a.length; i += step) {
    total++;
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
  }
  return same / total >= 0.995;
}

// Stability check on the BOTTOM band only — that's what gets appended, and
// it's where fast scrolling exposes not-yet-painted (dark) rows. Comparing
// just the band means a spinner elsewhere on the page can't stall the loop.
function bottomBandAlike(a, b, w, h) {
  if (!a || !b || a.length !== b.length) return false;
  const bandRows = Math.max(60, Math.floor(h * 0.3));
  const start = (h - bandRows) * w * 4;
  const step = Math.max(4, (((a.length - start) >> 11) & ~3) || 4);
  let same = 0, total = 0;
  for (let i = start; i < a.length; i += step) {
    total++;
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
  }
  return same / total >= 0.995;
}

class ScrollSession {
  // display: Electron Display; rect: region in image (device) pixels; hooks: {onStatus}
  constructor(display, rect, hooks = {}) {
    this.display = display;
    this.rect = rect;
    this.hooks = hooks;
    this.stitcher = new Stitcher(rect.width, rect.height);
    this.running = false;
    this.frames = 0;
    this.timer = null;
    this.busy = false;
  }

  start(intervalMs = 380) {
    this.running = true;
    const tick = async () => {
      if (!this.running || this.busy) return;
      this.busy = true;
      try {
        const { image } = await captureDisplay(this.display);
        if (!this.running) return; // stopped while capturing
        const region = image.crop(this.rect);
        const buf = region.toBitmap();
        const res = this.stitcher.push(buf);
        this.frames++;
        if (this.hooks.onStatus) {
          this.hooks.onStatus({ phase: 'capture', height: res.total, frames: this.frames, added: res.added, full: !!res.full });
        }
        if (res.full) this.running = false;
      } catch (err) {
        console.error('scroll tick failed:', err);
      } finally {
        this.busy = false;
      }
    };
    this.timer = setInterval(tick, intervalMs);
    tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stitcher.totalH === 0) return null;
    const { buffer, width, height } = this.stitcher.compose();
    return nativeImage.createFromBitmap(buffer, { width, height });
  }

  cancel() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// Auto full-page session. Loop shape (order matters): post wheel → wait for
// the bottom band to stabilize (scrolled AND painted — fast scrolling exposes
// unrasterized dark rows exactly where we append) → push. See CLAUDE.md.
class AutoScrollSession {
  // ratio maps css px -> device px (needed to aim the wheel at the region center)
  constructor(display, rect, ratio, hooks = {}) {
    this.display = display;
    this.rect = rect;
    this.ratio = ratio || display.scaleFactor || 1;
    this.hooks = hooks;
    // wider delta search than manual mode: our wheel steps are the only
    // scroll source, so a generous range beats a tight overlap guarantee
    this.stitcher = new Stitcher(rect.width, rect.height, { minOverlapFrac: 0.12 });
    if (process.env.TERMINALSHOT_TEST === '1') {
      this.stitcher.debug = global.__stitchLog = [];
    }
    this.running = false;
    this.frames = 0;
  }

  async captureRegion() {
    if (this.useStream) {
      try {
        return await grab.frame(this.rect);
      } catch (err) {
        console.error('stream frame failed, falling back:', err.message);
        this.useStream = false;
      }
    }
    const { image } = await captureDisplay(this.display);
    return image.crop(this.rect).toBitmap();
  }

  targetPoint() {
    const b = this.display.bounds;
    const dip = {
      x: Math.round(b.x + (this.rect.x + this.rect.width / 2) / this.ratio),
      y: Math.round(b.y + (this.rect.y + this.rect.height / 2) / this.ratio),
    };
    // Win32 wants physical screen coords
    try {
      if (screen.dipToScreenPoint) return screen.dipToScreenPoint(dip);
    } catch {}
    return dip;
  }

  start() {
    this.running = true;
    this._run().catch(err => {
      console.error('auto-scroll session failed:', err);
      global.__lastAutoError = String(err && err.stack || err);
      if (this.running && this.hooks.onAutoDone) this.hooks.onAutoDone();
    });
  }

  async _run() {
    const trace = m => { (global.__autoTrace = global.__autoTrace || []).push(m); };
    global.__autoTrace = [];
    const status = s => { if (this.hooks.onStatus) this.hooks.onStatus(s); };
    trace('run-start');
    if (!wheel.available()) {
      status({ phase: 'error', message: 'Auto-scroll unavailable — use manual Scrolling mode' });
      await delay(1800);
      if (this.hooks.onAutoDone) this.hooks.onAutoDone();
      return;
    }
    const pt = this.targetPoint();
    const target = wheel.resolve(pt.x, pt.y);
    trace('target ' + JSON.stringify(pt) + ' child=' + (target && target.childClass) + ' root=' + (target && target.rootClass));

    // persistent stream: ~20 ms frames vs ~600 ms one-shot captures
    this.useStream = false;
    try {
      await grab.start(this.display);
      this.useStream = true;
      trace('stream-on');
    } catch (err) {
      trace('stream-fallback: ' + err.message);
    }
    // streamed frames carry YUV 4:2:0 noise → tolerance matching; one-shot
    // frames are exact BGRA → exact hashes
    this.stitcher = new Stitcher(this.rect.width, this.rect.height, {
      minOverlapFrac: 0.12,
      fuzzy: this.useStream,
    });
    if (process.env.TERMINALSHOT_TEST === '1') {
      this.stitcher.debug = global.__stitchLog = [];
    }
    // 'child' works for real Chrome (legacy input HWND); Electron/WebView2 apps
    // often need 'root'. Probe child first, switch when nothing moves.
    let strategy = 'child';

    // Phase 0 — pick a working strategy: post a down-wheel and see if the
    // region reacts (unlike rewind, at an unknown position "down" must move)
    let probe = await this.captureRegion();
    for (const s of ['child', 'root']) {
      wheel.wheelAt(pt.x, pt.y, -3, s);
      await delay(340);
      if (!this.running) return;
      const after = await this.captureRegion();
      const moved = !framesAlike(probe, after);
      probe = after;
      if (moved) { strategy = s; trace('strategy=' + s); break; }
      if (s === 'root') trace('no-strategy-responded');
    }

    // Phase 1 — rewind to the top of the page
    status({ phase: 'rewind', height: 0, frames: 0 });
    let prev = probe;
    let stable = 0;
    let responded = false;
    for (let i = 0; i < 60 && this.running; i++) {
      wheel.wheelAt(pt.x, pt.y, 12, strategy);
      await delay(130);
      if (!this.running) { trace('stopped-during-rewind@' + i); return; }
      const cur = await this.captureRegion();
      if (framesAlike(prev, cur)) {
        stable++;
        if (stable >= 2) { trace('rewind-top@' + i); break; }
      } else {
        stable = 0;
        responded = true;
      }
      prev = cur;
    }
    if (!this.running) { trace('stopped-after-rewind'); return; }

    // Phase 2 — continuous pipeline: capture → stitch → post wheel → repeat,
    // with NO artificial waits. Mid-animation frames are fine (any scroll
    // state matches its predecessor at a partial delta) — smooth-scrolling
    // apps smear big wheel batches across several captures on their own.
    // The only hard limit is instant-scroll apps, where one batch = one jump
    // between captures; `obs` tracks the worst observed px-per-notch so the
    // batch size never grows past the stitcher's searchable delta.
    const maxDelta = this.rect.height - this.stitcher.minOverlap;
    const { width: rw, height: rh } = this.rect;
    let notches = 1;
    let obs = 0;         // worst-case measured px per notch
    let stallQuiet = 0;  // consecutive frames with NO pixel change → bottom
    let stallAny = 0;    // consecutive frames without stitched growth → safety stop
    let first = true;
    while (this.running) {
      let frame;
      if (first) {
        // page is at rest right after rewind
        frame = await this.captureRegion();
        first = false;
      } else {
        wheel.wheelAt(pt.x, pt.y, -notches, strategy);
        await delay(this.useStream ? 60 : 30);
        frame = await this.captureRegion();
        // wait until the bottom band (the part we append) is stable across
        // two consecutive frames — i.e. the scroll finished AND the renderer
        // painted the newly exposed rows. Fast scrolling otherwise bakes
        // dark not-yet-rasterized strips into the output.
        if (this.useStream) {
          for (let s = 0; s < 10 && this.running; s++) {
            await delay(45);
            const again = await this.captureRegion();
            const stable = bottomBandAlike(frame, again, rw, rh);
            frame = again;
            if (stable) break;
          }
        }
      }
      if (!this.running) break;

      if (process.env.TERMINALSHOT_DUMP && this.frames < 40) {
        try {
          const fs = require('fs');
          const img = nativeImage.createFromBitmap(frame, { width: rw, height: rh });
          fs.writeFileSync(require('path').join(process.env.TERMINALSHOT_DUMP, `frame-${this.frames}.png`), img.toPNG());
        } catch {}
      }
      const res = this.stitcher.push(frame);
      this.frames++;
      status({ phase: 'capture', height: res.total, frames: this.frames, added: res.added, full: !!res.full });
      if (res.full) break;
      if (res.added === 0) {
        stallAny++;
        if (!res.miss && this.frames > 1) stallQuiet++;
        if (res.miss && notches > 1) { notches = Math.max(1, notches >> 1); trace('miss→n' + notches); }
        // quiet = truly at the bottom; stallAny catches infinite feeds whose
        // loading spinners keep "changing" without ever scrolling
        if (stallQuiet >= 3 || stallAny >= 10) {
          trace('stall-break f' + this.frames + ' h' + res.total + ' quiet' + stallQuiet);
          break;
        }
      } else {
        stallQuiet = 0;
        stallAny = 0;
        responded = true;
        // track worst-case px-per-notch and grow the batch while the NEXT
        // batch would still land inside the searchable delta
        obs = Math.max(obs * 0.9, res.added / notches);
        if ((notches + 1) * obs <= maxDelta * 0.8 && notches < 8) notches++;
        else if (notches * obs > maxDelta * 0.95 && notches > 1) notches--;
      }
      if (this.frames >= 400) { trace('frame-cap'); break; }
    }
    if (!this.running) { trace('stopped-in-loop'); return; }
    trace('loop-done f' + this.frames + ' h' + this.stitcher.totalH + ' responded=' + responded);

    if (!responded && this.frames <= 4) {
      status({ phase: 'error', message: "Window didn't respond to auto-scroll — try manual Scrolling mode" });
      await delay(1800);
    }
    if (this.hooks.onAutoDone) this.hooks.onAutoDone();
  }

  stop() {
    this.running = false;
    grab.stop();
    if (this.stitcher.totalH === 0) return null;
    const { buffer, width, height } = this.stitcher.compose();
    return nativeImage.createFromBitmap(buffer, { width, height });
  }

  cancel() {
    this.running = false;
    grab.stop();
  }
}

module.exports = { ScrollSession, AutoScrollSession };
