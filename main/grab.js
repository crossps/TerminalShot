'use strict';
// Main-process client for the hidden grabber window (persistent screen stream).
const { ipcMain, desktopCapturer } = require('electron');
const W = require('./windows');

let seq = 0;
const pending = new Map();

ipcMain.on('grab:reply', (e, msg) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg);
  else p.reject(new Error(msg.err || 'grab failed'));
});

function rpc(op, payload = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const win = W.get('grabber');
    if (!win) return reject(new Error('grabber window missing'));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    win.webContents.send('grab:op', { id, op, ...payload });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('grab rpc timeout: ' + op));
      }
    }, timeoutMs);
  });
}

// Start a persistent stream for one display.
async function start(display) {
  // resolve the screen source id without thumbnails (cheap)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!src) throw new Error('no screen source');
  const dw = Math.round(display.size.width * display.scaleFactor);
  const dh = Math.round(display.size.height * display.scaleFactor);
  await rpc('start', { sourceId: src.id, dw, dh }, 9000);
}

// Grab one BGRA region frame (rect in device px).
async function frame(rect) {
  const r = await rpc('frame', { rect });
  const u8 = r.buf;
  return Buffer.from(u8.buffer || u8, u8.byteOffset || 0, u8.byteLength || u8.length);
}

function stop() {
  rpc('stop', {}, 2000).catch(() => {});
}

module.exports = { start, frame, stop };
