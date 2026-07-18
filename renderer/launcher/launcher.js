'use strict';
const { ipcRenderer } = require('electron');

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let settings = null;
let hotkeyStatus = {};

// icons
$('#btnMin').innerHTML = fsIcon('min');
$('#btnHide').innerHTML = fsIcon('x');
$('#btnSettings').innerHTML = fsIcon('gear');
$('#btnSettingsClose').innerHTML = fsIcon('x');
for (const el of $$('.mode')) {
  el.querySelector('.mode-icon').innerHTML = fsIcon(el.dataset.mode);
}

const HK_LABEL = { page: 'Full page (auto)', area: 'Area', window: 'Window', full: 'Full screen', scroll: 'Scrolling' };
const prettyAccel = a => a.replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');

function toast(msg) {
  $('#toastMsg').textContent = msg;
  const t = $('#toast');
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

async function loadSettings() {
  const res = await ipcRenderer.invoke('settings:get');
  settings = res.settings;
  hotkeyStatus = res.hotkeyStatus || {};
  applySettingsUi();
}

function applySettingsUi() {
  for (const el of $$('[data-hk]')) {
    const key = el.dataset.hk;
    el.textContent = prettyAccel(settings.hotkeys[key] || '');
  }
  $('#tglCopy').classList.toggle('on', !!settings.autoCopy);
  $('#rngThumb').value = settings.thumbSeconds;
  $('#thumbSecsLabel').textContent = settings.thumbSeconds + 's';
  $('#savePathLabel').textContent = settings.savePath;
  $('#savePathLabel').title = settings.savePath;
  const list = $('#hotkeyList');
  list.innerHTML = '';
  for (const [mode, accel] of Object.entries(settings.hotkeys)) {
    const row = document.createElement('div');
    row.className = 'hk-row';
    const ok = hotkeyStatus[mode] !== false;
    row.innerHTML = `<span>${HK_LABEL[mode] || mode}${ok ? '' : '<span class="bad">IN USE BY ANOTHER APP</span>'}</span><span class="fs-kbd">${prettyAccel(accel)}</span>`;
    list.appendChild(row);
  }
}

async function loadRecents() {
  const items = await ipcRenderer.invoke('recents:get');
  const wrap = $('#recents');
  wrap.innerHTML = '';
  $('#recentsEmpty').style.display = items.length ? 'none' : 'block';
  wrap.style.display = items.length ? 'flex' : 'none';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'recent';
    el.title = 'Click to edit · Right-click to show in folder';
    const d = new Date(it.time);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    el.innerHTML = `<img loading="lazy" src="${it.url}" /><span>${label}</span>`;
    el.addEventListener('click', () => ipcRenderer.send('recents:open', { path: it.path }));
    el.addEventListener('contextmenu', () => ipcRenderer.send('shell:showItem', { path: it.path }));
    wrap.appendChild(el);
  }
}

// ---- events
for (const el of $$('.mode')) {
  el.addEventListener('click', () => ipcRenderer.send('ui:mode', { mode: el.dataset.mode }));
}
$('#btnMin').addEventListener('click', () => ipcRenderer.send('win:op', { op: 'min' }));
$('#btnHide').addEventListener('click', () => ipcRenderer.send('win:op', { op: 'hide' }));
$('#btnFolder').addEventListener('click', () => ipcRenderer.send('shell:openCaptures'));
$('#btnOpenFolder2').addEventListener('click', () => ipcRenderer.send('shell:openCaptures'));
$('#btnQuit').addEventListener('click', () => ipcRenderer.send('app:quit'));

$('#btnSettings').addEventListener('click', () => $('#settings').classList.toggle('open'));
$('#btnSettingsClose').addEventListener('click', () => $('#settings').classList.remove('open'));

$('#tglCopy').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('settings:set', { autoCopy: !settings.autoCopy });
  settings = res.settings;
  applySettingsUi();
});
$('#rngThumb').addEventListener('input', e => {
  $('#thumbSecsLabel').textContent = e.target.value + 's';
});
$('#rngThumb').addEventListener('change', async e => {
  const res = await ipcRenderer.invoke('settings:set', { thumbSeconds: Number(e.target.value) });
  settings = res.settings;
});
$('#btnChangeFolder').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('settings:pickFolder');
  if (res.ok) {
    settings = res.settings;
    applySettingsUi();
    loadRecents();
    toast('Save folder updated');
  }
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('#settings').classList.contains('open')) $('#settings').classList.remove('open');
    else ipcRenderer.send('win:op', { op: 'hide' });
  }
});

ipcRenderer.on('launcher:reveal', () => {
  $('#card').classList.add('reveal');
  loadRecents();
});
ipcRenderer.on('recents:changed', loadRecents);

loadSettings();
loadRecents();
requestAnimationFrame(() => $('#card').classList.add('reveal'));
