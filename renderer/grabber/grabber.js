'use strict';
// Hidden frame-grabber. Holds a persistent getUserMedia screen stream during
// auto scroll sessions and serves cropped region frames over IPC — ~20 ms per
// frame vs ~600 ms for a one-shot desktopCapturer.getSources call.
const { ipcRenderer } = require('electron');

let stream = null;
let video = null;
let canvas = null;
let ctx = null;

function stopStream() {
  if (stream) {
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch {}
    }
  }
  stream = null;
  video = null;
  canvas = null;
  ctx = null;
}

ipcRenderer.on('grab:op', async (e, msg) => {
  const { id, op } = msg;
  const reply = (ok, extra = {}) => { if (id) ipcRenderer.send('grab:reply', { id, ok, ...extra }); };
  try {
    if (op === 'start') {
      stopStream();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: msg.sourceId,
            minWidth: msg.dw, maxWidth: msg.dw,
            minHeight: msg.dh, maxHeight: msg.dh,
          },
        },
      });
      video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      // wait until real frames flow
      await new Promise(res => {
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => res());
        else setTimeout(res, 350);
      });
      reply(true, { vw: video.videoWidth, vh: video.videoHeight });
    } else if (op === 'frame') {
      if (!video) throw new Error('no stream');
      const r = msg.rect;
      if (!canvas || canvas.width !== r.width || canvas.height !== r.height) {
        canvas = document.createElement('canvas');
        canvas.width = r.width;
        canvas.height = r.height;
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ctx.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
      const d = ctx.getImageData(0, 0, r.width, r.height);
      // canvas gives RGBA; the rest of the pipeline (and compose) is BGRA
      const a = d.data;
      for (let i = 0; i < a.length; i += 4) {
        const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t;
      }
      reply(true, { buf: a });
    } else if (op === 'stop') {
      stopStream();
      reply(true);
    }
  } catch (err) {
    reply(false, { err: String(err && err.message || err) });
  }
});
