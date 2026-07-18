'use strict';
// Settings persistence — plain JSON under the current user's app-data folder.
const fs = require('fs');
const path = require('path');

let settings = null;
let dataDir = null;
let file = null;

const DEFAULTS = app => ({
  savePath: path.join(app.getPath('pictures'), 'TerminalShot'),
  autoCopy: true,
  thumbSeconds: 6,
  hotkeys: {
    full: 'Control+Alt+F',
    window: 'Control+Alt+W',
    area: 'Control+Alt+A',
    scroll: 'Control+Alt+S',
    page: 'Control+Alt+P',
  },
});

function init(app) {
  dataDir = process.env.TERMINALSHOT_DATA_DIR || path.join(app.getPath('userData'), 'data');
  file = path.join(dataDir, 'settings.json');
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyFile = path.join(__dirname, '..', 'data', 'settings.json');
  if (!fs.existsSync(file) && fs.existsSync(legacyFile)) {
    try { fs.copyFileSync(legacyFile, file); } catch {}
  }
  const defs = DEFAULTS(app);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings = { ...defs, ...raw, hotkeys: { ...defs.hotkeys, ...(raw.hotkeys || {}) } };
  } catch {
    settings = defs;
  }
  fs.mkdirSync(settings.savePath, { recursive: true });
  persist();
}

function persist() {
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

function get() {
  return settings;
}

function set(patch) {
  settings = { ...settings, ...patch, hotkeys: { ...settings.hotkeys, ...((patch && patch.hotkeys) || {}) } };
  try { fs.mkdirSync(settings.savePath, { recursive: true }); } catch {}
  persist();
  return settings;
}

function location() {
  return { dataDir, file };
}

module.exports = { init, get, set, location };
