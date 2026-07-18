'use strict';
// Reproducible, privacy-safe README screenshots rendered by the real Electron app.
const fs = require('fs');
const path = require('path');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const DATA = path.join(__dirname, '.docs-data');
const CAPTURES = path.join(DATA, 'captures');
const FIXTURE = path.join(CAPTURES, 'TerminalShot_release-checklist.png');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CAPTURES, { recursive: true });
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  savePath: CAPTURES,
  autoCopy: false,
  thumbSeconds: 30,
}, null, 2));

async function waitFor(fn, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await fn()) return true; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

(async () => {
  const app = await _electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, TERMINALSHOT_TEST: '1', TERMINALSHOT_DATA_DIR: DATA },
  });
  const pages = {};
  const errors = [];
  const classify = page => {
    const url = page.url();
    for (const name of ['launcher', 'editor']) {
      if (url.includes(`/${name}/`)) pages[name] = page;
    }
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(String(error)));
  };
  app.on('window', classify);
  for (const page of app.windows()) classify(page);

  const main = (fn, arg) => app.evaluate(fn, arg);
  if (!await waitFor(() => pages.launcher)) throw new Error('Launcher did not open');
  await pages.launcher.waitForSelector('.mode', { state: 'visible', timeout: 5000 });
  await pages.launcher.screenshot({ path: path.join(OUT, 'terminalshot-launcher.png') });

  await main((electron, file) => global.__fstest.makeDocFixture(file), FIXTURE);
  await main((electron, file) => global.__fstest.openEditor(file), FIXTURE);
  if (!await waitFor(() => pages.editor && pages.editor.evaluate(() => window.__fsEd.state().iw > 0))) {
    throw new Error('Editor fixture did not load');
  }

  await pages.editor.click('[data-tool="rect"]');
  const viewport = await pages.editor.evaluate(() => {
    const r = document.querySelector('#viewport').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = viewport.x + viewport.w / 2;
  const cy = viewport.y + viewport.h / 2;
  await pages.editor.mouse.move(cx - 290, cy - 115);
  await pages.editor.mouse.down();
  await pages.editor.mouse.move(cx + 40, cy + 75, { steps: 8 });
  await pages.editor.mouse.up();
  await pages.editor.click('[data-tool="arrow"]');
  await pages.editor.mouse.move(cx + 320, cy - 145);
  await pages.editor.mouse.down();
  await pages.editor.mouse.move(cx + 95, cy - 30, { steps: 8 });
  await pages.editor.mouse.up();
  await pages.editor.evaluate(() => window.__fsEd.addText(820, 560, 'Release artifact'));
  await pages.editor.screenshot({ path: path.join(OUT, 'terminalshot-editor.png') });

  const realErrors = errors.filter(error => !/favicon|Autofill|ERR_CACHE/i.test(error));
  if (realErrors.length) throw new Error(`Renderer errors: ${realErrors.join(' | ')}`);
  await app.close();
  console.log(`README screenshots written to ${OUT}`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
