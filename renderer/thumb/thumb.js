'use strict';
const { ipcRenderer } = require('electron');

const $ = s => document.querySelector(s);
const card = $('#card');
const ringFg = $('#ringFg');
const ring = $('#ring');

$('#aEdit').innerHTML = fsIcon('edit');
$('#aCopy').innerHTML = fsIcon('copy');
$('#aSave').innerHTML = fsIcon('saveas');
$('#aFolder').innerHTML = fsIcon('folder');
$('#aPin').innerHTML = fsIcon('pin');
$('#aClose').innerHTML = fsIcon('x');

const CIRC = 81.7;
let cur = null;          // current capture payload
let timer = null;        // dismiss timer state
let pinned = false;
let dragging = false;

function startTimer(seconds) {
  stopTimer();
  timer = { total: seconds * 1000, left: seconds * 1000, last: performance.now(), paused: false, raf: 0 };
  ring.classList.remove('hidden');
  const step = now => {
    if (!timer) return;
    if (!timer.paused) {
      timer.left -= now - timer.last;
      if (timer.left <= 0) { dismiss(); return; }
    }
    timer.last = now;
    ringFg.style.strokeDashoffset = CIRC * (1 - timer.left / timer.total);
    timer.raf = requestAnimationFrame(step);
  };
  timer.raf = requestAnimationFrame(step);
}
function stopTimer() {
  if (timer) cancelAnimationFrame(timer.raf);
  timer = null;
}
function pauseTimer(p) {
  if (timer) { timer.paused = p; timer.last = performance.now(); }
}

function dismiss() {
  stopTimer();
  card.classList.remove('in');
  card.classList.add('out');
  setTimeout(() => ipcRenderer.send('thumb:action', { action: 'close', path: cur && cur.path }), 210);
}

ipcRenderer.on('thumb:show', (e, payload) => {
  cur = payload;
  pinned = false;
  dragging = false;
  $('#aPin').classList.remove('active');
  $('#copied').classList.remove('show');
  $('#shot').src = payload.dataURL;
  $('#dims').textContent = `${payload.w} × ${payload.h}`;
  card.classList.remove('out');
  card.classList.remove('in');
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
  startTimer(payload.seconds || 6);
  setTimeout(() => $('#copied').classList.add('show'), 350);
});

// hover pauses the countdown
card.addEventListener('mouseenter', () => pauseTimer(true));
card.addEventListener('mouseleave', () => { if (!pinned) pauseTimer(false); });

// drag the actual PNG file out to any app
$('#imgWrap').addEventListener('dragstart', e => {
  e.preventDefault();
  if (!cur) return;
  dragging = true;
  stopTimer();
  ring.classList.add('hidden');
  ipcRenderer.send('thumb:drag', { path: cur.path });
  setTimeout(() => { dragging = false; }, 300);
});

// click (not drag) → editor
$('#imgWrap').addEventListener('click', () => {
  if (dragging || !cur) return;
  stopTimer();
  ipcRenderer.send('thumb:action', { action: 'edit', path: cur.path });
});

$('#aEdit').addEventListener('click', () => {
  stopTimer();
  ipcRenderer.send('thumb:action', { action: 'edit', path: cur.path });
});
$('#aCopy').addEventListener('click', () => {
  ipcRenderer.send('thumb:action', { action: 'copy', path: cur.path });
  $('#copied').classList.add('show');
});
$('#aSave').addEventListener('click', () => {
  pin(true);
  ipcRenderer.send('thumb:action', { action: 'saveas', path: cur.path });
});
$('#aFolder').addEventListener('click', () => ipcRenderer.send('thumb:action', { action: 'folder', path: cur.path }));
$('#aPin').addEventListener('click', () => pin(!pinned));
$('#aClose').addEventListener('click', dismiss);

function pin(v) {
  pinned = v;
  $('#aPin').classList.toggle('active', pinned);
  if (pinned) { stopTimer(); ring.classList.add('hidden'); }
  else if (cur) startTimer(Math.max(3, cur.seconds || 6));
}

window.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });
