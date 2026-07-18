'use strict';
const { ipcRenderer } = require('electron');

const $ = s => document.querySelector(s);
$('#btnClose').innerHTML = fsIcon('x');
$('#btnRefresh').innerHTML = fsIcon('refresh') + '<span>Refresh</span>';

ipcRenderer.on('picker:data', (e, { items }) => {
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#count').textContent = items.length + (items.length === 1 ? ' window' : ' windows');
  $('#empty').style.display = items.length ? 'none' : 'block';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'witem';
    el.title = it.name;
    el.innerHTML = `
      <div class="shot"><img src="${it.thumb}" draggable="false" /></div>
      <div class="meta">${it.icon ? `<img src="${it.icon}" draggable="false" />` : '<span class="noicon"></span>'}<span></span></div>`;
    el.querySelector('.meta span:last-child').textContent = it.name;
    el.addEventListener('click', () => ipcRenderer.send('picker:pick', { id: it.id }));
    grid.appendChild(el);
  }
  const card = $('#card');
  card.classList.remove('in');
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
});

$('#btnClose').addEventListener('click', () => ipcRenderer.send('picker:cancel'));
$('#btnRefresh').addEventListener('click', () => ipcRenderer.send('picker:refresh'));
window.addEventListener('keydown', e => { if (e.key === 'Escape') ipcRenderer.send('picker:cancel'); });
