'use strict';
// Screen / window capture via desktopCapturer (single-shot thumbnails — cursor-free).
const { desktopCapturer, screen } = require('electron');

// Capture one display at native pixel resolution. Returns { image, ratio } where
// ratio maps display DIP coords -> image pixel coords (handles DPI scaling).
async function captureDisplay(display) {
  const w = Math.round(display.size.width * display.scaleFactor);
  const h = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h },
  });
  if (!sources.length) throw new Error('No screen sources available');
  let src = sources.find(s => s.display_id === String(display.id));
  if (!src) {
    // fallback: match by index in display list, else first
    const all = screen.getAllDisplays();
    const idx = all.findIndex(d => d.id === display.id);
    src = sources[idx] || sources[0];
  }
  const image = src.thumbnail;
  const size = image.getSize();
  return { image, ratio: size.width / display.bounds.width };
}

// Snapshot every open window (excluding our own). Thumbnails are captured at the
// moment of this call, so the picker shows a frozen, occlusion-free snapshot.
async function listWindows(ownIds) {
  const primary = screen.getPrimaryDisplay();
  const w = Math.round(primary.size.width * primary.scaleFactor);
  const h = Math.round(primary.size.height * primary.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: w, height: h },
    fetchWindowIcons: true,
  });
  return sources.filter(s => {
    if (ownIds.has(s.id)) return false;
    const sz = s.thumbnail.getSize();
    return sz.width > 32 && sz.height > 32;
  });
}

module.exports = { captureDisplay, listWindows };
