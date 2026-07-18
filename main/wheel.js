'use strict';
// Targeted mouse-wheel scrolling: PostMessageW(WM_MOUSEWHEEL) to the window
// under a specific screen point, via koffi FFI.
//
// This is ADDRESSED window messaging, NOT input injection: the message goes to
// one resolved HWND and by construction cannot reach any other window (unlike
// SendInput/SendKeys, which feed the global input stream). Same technique
// PicPick/ShareX use for scrolling capture.
//
// Target strategies: 'child' posts to the deepest window under the point
// (real Chrome routes wheel through its legacy Chrome_RenderWidgetHostHWND);
// 'root' posts to the GA_ROOT top-level window (Electron/WebView2 apps often
// have a D3D child that ignores wheel — their top-level handler processes it).
// Callers probe 'child' first and fall back to 'root' when nothing moves.

const WM_MOUSEWHEEL = 0x020a;
const GA_ROOT = 2;
let api; // undefined = not tried, false = unavailable

function init() {
  if (api !== undefined) return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
    api = {
      WindowFromPoint: user32.func('__stdcall', 'WindowFromPoint', 'void*', [POINT]),
      GetAncestor: user32.func('__stdcall', 'GetAncestor', 'void*', ['void*', 'uint']),
      PostMessageW: user32.func('__stdcall', 'PostMessageW', 'bool', ['void*', 'uint', 'uintptr_t', 'intptr_t']),
      GetClassNameW: user32.func('__stdcall', 'GetClassNameW', 'int', ['void*', 'void*', 'int']),
    };
  } catch (err) {
    console.error('koffi unavailable — auto full-page capture disabled:', err.message);
    api = false;
  }
  return api;
}

function available() {
  return !!init();
}

function className(hwnd) {
  const a = init();
  if (!a || !hwnd) return '';
  try {
    const out = Buffer.alloc(256);
    const n = a.GetClassNameW(hwnd, out, 128);
    return out.toString('utf16le', 0, Math.max(0, n) * 2);
  } catch {
    return '?';
  }
}

// Resolve the windows under a physical screen point.
function resolve(x, y) {
  const a = init();
  if (!a) return null;
  const child = a.WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
  if (!child) return null;
  let root = null;
  try { root = a.GetAncestor(child, GA_ROOT); } catch {}
  return {
    child,
    root: root || child,
    childClass: className(child),
    rootClass: className(root || child),
  };
}

// Post `notches` wheel clicks (positive = up, negative = down) to the window
// under physical screen point (x, y). strategy: 'child' | 'root'.
function wheelAt(x, y, notches, strategy = 'child') {
  const a = init();
  if (!a) return false;
  const t = resolve(x, y);
  if (!t) return false;
  const hwnd = strategy === 'root' ? t.root : t.child;
  const px = Math.round(x), py = Math.round(y);
  const dir = notches > 0 ? 120 : -120;
  const count = Math.abs(notches);
  const lparam = ((py & 0xffff) << 16) | (px & 0xffff);
  for (let i = 0; i < count; i++) {
    const wparam = ((dir & 0xffff) << 16) >>> 0;
    a.PostMessageW(hwnd, WM_MOUSEWHEEL, wparam, lparam);
  }
  return true;
}

module.exports = { available, wheelAt, resolve };
