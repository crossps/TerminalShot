'use strict';
const { ipcRenderer } = require('electron');
const $ = s => document.querySelector(s);

$('#btnCancel').innerHTML = fsIcon('x');

let auto = false;

ipcRenderer.on('scroll:begin', (e, opts) => {
  auto = !!(opts && opts.auto);
  $('#statusLine').textContent = auto ? 'Rewinding to the top…' : 'Scroll the content…';
  $('#btnDone').textContent = auto ? 'Stop & save' : 'Done';
  $('#height').textContent = '0';
  $('#frames').textContent = '0';
});

ipcRenderer.on('scroll:status', (e, st) => {
  if (st.phase === 'error') {
    $('#statusLine').textContent = st.message || 'Something went wrong';
    return;
  }
  if (st.height != null) $('#height').textContent = st.height.toLocaleString();
  if (st.frames != null) $('#frames').textContent = st.frames;
  if (st.phase === 'rewind') {
    $('#statusLine').textContent = 'Rewinding to the top…';
  } else if (st.full) {
    $('#statusLine').textContent = 'Max height reached — finishing…';
  } else if (auto) {
    $('#statusLine').textContent = 'Auto-capturing the page…';
  } else {
    $('#statusLine').textContent = st.added > 0 ? 'Capturing new content…' : 'Scroll the content…';
  }
});

$('#btnDone').addEventListener('click', () => ipcRenderer.send('scroll:stop'));
$('#btnCancel').addEventListener('click', () => ipcRenderer.send('scroll:cancel'));
window.addEventListener('keydown', e => {
  if (e.key === 'Enter') ipcRenderer.send('scroll:stop');
  if (e.key === 'Escape') ipcRenderer.send('scroll:cancel');
});
