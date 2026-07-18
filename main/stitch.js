'use strict';
// Scrolling-capture stitcher. Pure Node (no Electron) so it can be unit-tested.
//
// Frames are raw BGRA buffers of a fixed region (w × h). The user (or the auto
// scroller) scrolls the content; we detect the vertical scroll delta between
// consecutive frames and append only the new bottom rows.
//
// v2: real pages have static content beside the scrolling column — sidebars,
// background art, browser chrome, a moving scrollbar thumb. Hashing whole rows
// makes those pages unmatchable at every offset (v1 bug: "captures nothing").
// So each push:
//   1. finds the RUNS of contiguous columns that actually changed between the
//      two frames (static sidebars are never inside a run),
//   2. trims each run's edges by one sample step (so a boundary can't bleed
//      static pixels into the hash) and drops slivers — which conveniently
//      also drops a moving scrollbar thumb,
//   3. hashes rows per-run and scores a scroll offset by WIDTH-WEIGHTED VOTE
//      across runs — one noisy run (animated ad, spinner) can't veto a match.

function detectChangedRuns(prev, next, w, h) {
  const stride = w * 4;
  const colStep = Math.max(1, w >> 9);   // sample ~512 columns
  const rowStep = Math.max(1, h >> 7);   // sample ~128 rows per column
  const changed = []; // sampled column indices that changed
  for (let x = 0; x < w; x += colStep) {
    let hits = 0;
    const off = x * 4;
    for (let y = 0; y < h; y += rowStep) {
      const i = y * stride + off;
      if (prev[i] !== next[i] || prev[i + 1] !== next[i + 1] || prev[i + 2] !== next[i + 2]) {
        hits++;
        if (hits >= 2) break;
      }
    }
    if (hits >= 2) changed.push(x);
  }
  if (!changed.length) return null;

  // group consecutive samples into runs, trim edges by one step, drop slivers
  const runs = [];
  let start = changed[0], last = changed[0];
  const flush = () => {
    const x0 = start + colStep, x1 = last - colStep; // conservative interior
    if (x1 - x0 >= 12) runs.push({ x0, x1, w: x1 - x0 + 1 });
  };
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - last === colStep) {
      last = changed[k];
    } else {
      flush();
      start = changed[k];
      last = changed[k];
    }
  }
  flush();
  if (!runs.length) return null;
  runs.sort((a, b) => b.w - a.w);
  return runs.slice(0, 8);
}

// Per-row FNV hash over a column window [x0, x1] (pixel indices).
function rowHashesWindow(buf, w, h, x0, x1) {
  const hashes = new Uint32Array(h);
  const stride = w * 4;
  const span = x1 - x0 + 1;
  const step = Math.max(1, span >> 7) * 4; // sample ~128 pixels per row
  const start = x0 * 4, end = (x1 + 1) * 4;
  for (let y = 0; y < h; y++) {
    let hsh = 0x811c9dc5;
    const row = y * stride;
    for (let x = start; x < end; x += step) {
      hsh ^= buf[row + x]; hsh = (hsh * 0x01000193) >>> 0;      // B
      hsh ^= buf[row + x + 1]; hsh = (hsh * 0x01000193) >>> 0;  // G
      hsh ^= buf[row + x + 2]; hsh = (hsh * 0x01000193) >>> 0;  // R
    }
    hashes[y] = hsh;
  }
  return hashes;
}

// Back-compat helper (full-width hashes).
function rowHashes(buf, w, h) {
  return rowHashesWindow(buf, w, h, 0, w - 1);
}

// Fuzzy row signatures for noisy sources (getUserMedia streams travel as YUV
// 4:2:0 — scrolling by an odd pixel count changes chroma block pairing, so
// scrolled rows are no longer bit-identical and exact hashes miss). Each row
// gets K chunk-averaged ~luma values; averaging cancels the chroma noise.
function rowSigsWindow(buf, w, h, x0, x1, K) {
  const sigs = new Int16Array(h * K);
  const stride = w * 4;
  const span = x1 - x0 + 1;
  const chunk = span / K;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let k = 0; k < K; k++) {
      const cs = x0 + Math.floor(k * chunk);
      const ce = Math.max(cs + 1, x0 + Math.floor((k + 1) * chunk));
      const step = Math.max(1, (ce - cs) >> 4); // ≤16 samples per chunk
      let sum = 0, n = 0;
      for (let x = cs; x < ce; x += step) {
        const i = row + x * 4;
        sum += buf[i] + 2 * buf[i + 1] + buf[i + 2]; // ~4×luma (B+2G+R)
        n++;
      }
      sigs[y * K + k] = (sum / n) | 0;
    }
  }
  return sigs;
}

// Width-weighted vote over fuzzy signatures: a run agrees when the mean
// abs-difference across its K chunks stays under tol (in 4×luma units).
function scoreDeltaRunsFuzzy(prevSigs, nextSigs, weights, totalW, h, d, bandStart, K, tol) {
  let match = 0, total = 0;
  const end = h - d;
  const lim = tol * K;
  for (let i = bandStart; i < end; i += 2) {
    total++;
    let mw = 0;
    for (let r = 0; r < prevSigs.length; r++) {
      const a = prevSigs[r], b = nextSigs[r];
      const pa = (i + d) * K, pb = i * K;
      let acc = 0;
      for (let k = 0; k < K; k++) {
        const df = a[pa + k] - b[pb + k];
        acc += df < 0 ? -df : df;
      }
      if (acc <= lim) mw += weights[r];
    }
    if (mw / totalW >= 0.6) match++;
  }
  return total < 20 ? -1 : match / total;
}

// Width-weighted vote: a row matches at offset d when runs covering ≥60% of
// the total changed width agree that next[i] === prev[i + d].
function scoreDeltaRuns(prevRunH, nextRunH, weights, totalW, h, d, bandStart) {
  let match = 0, total = 0;
  const end = h - d;
  for (let i = bandStart; i < end; i += 2) {
    total++;
    let mw = 0;
    for (let r = 0; r < prevRunH.length; r++) {
      if (nextRunH[r][i] === prevRunH[r][i + d]) mw += weights[r];
    }
    if (mw / totalW >= 0.6) match++;
  }
  return total < 20 ? -1 : match / total;
}

class Stitcher {
  constructor(w, h, opts = {}) {
    this.w = w;
    this.h = h;
    this.minOverlap = Math.max(40, Math.floor(h * (opts.minOverlapFrac || 0.2)));
    this.bandStart = Math.floor(h * (opts.bandFrac == null ? 0.12 : opts.bandFrac));
    this.tol = opts.tol == null ? 0.86 : opts.tol;
    this.maxHeight = opts.maxHeight || 40000;
    this.fuzzy = !!opts.fuzzy;      // tolerance matching for YUV-noisy sources
    this.K = opts.sigChunks || 8;
    this.fuzzyTol = opts.fuzzyTol == null ? 10 : opts.fuzzyTol;
    this.chunks = [];
    this.totalH = 0;
    this.prevFrame = null;
    this.misses = 0;
  }

  // buf: BGRA Buffer, length w*h*4. Returns { added, total, full }.
  push(buf) {
    const { w, h } = this;
    if (buf.length !== w * h * 4) throw new Error('Stitcher: frame size mismatch');

    if (!this.prevFrame) {
      this.prevFrame = Buffer.from(buf);
      this.chunks.push(this.prevFrame);
      this.totalH = h;
      return { added: h, total: h, full: false };
    }

    // 1) which column runs actually changed since the last frame?
    const runs = detectChangedRuns(this.prevFrame, buf, w, h);
    if (!runs) {
      // identical frame (or only sliver-level noise like a cursor blink)
      this.prevFrame = Buffer.from(buf);
      return { added: 0, total: this.totalH, full: false };
    }

    // 2) signature rows per run, for both frames (fuzzy for noisy sources)
    const weights = runs.map(r => r.w);
    const totalW = weights.reduce((a, b) => a + b, 0);
    let score;
    if (this.fuzzy) {
      const prevS = runs.map(r => rowSigsWindow(this.prevFrame, w, h, r.x0, r.x1, this.K));
      const nextS = runs.map(r => rowSigsWindow(buf, w, h, r.x0, r.x1, this.K));
      score = d => scoreDeltaRunsFuzzy(prevS, nextS, weights, totalW, h, d, this.bandStart, this.K, this.fuzzyTol);
    } else {
      const prevH = runs.map(r => rowHashesWindow(this.prevFrame, w, h, r.x0, r.x1));
      const nextH = runs.map(r => rowHashesWindow(buf, w, h, r.x0, r.x1));
      score = d => scoreDeltaRuns(prevH, nextH, weights, totalW, h, d, this.bandStart);
    }

    const same = score(0);
    if (same >= 0.985) {
      this.prevFrame = Buffer.from(buf);
      return { added: 0, total: this.totalH, full: false };
    }

    // 3) search downward scroll delta; keep the smallest d within epsilon of
    // the best score (stable choice when content has repeating/blank regions)
    let bestD = -1, bestScore = -1;
    const maxD = h - this.minOverlap;
    for (let d = 1; d <= maxD; d++) {
      const s = score(d);
      if (s > bestScore + 0.01) { bestScore = s; bestD = d; }
    }

    this.prevFrame = Buffer.from(buf);
    if (this.debug) {
      this.debug.push({
        runs: runs.map(r => [r.x0, r.x1]),
        same: Number(same.toFixed(3)),
        bestScore: Number(bestScore.toFixed(3)),
        bestD,
        maxD,
      });
    }
    if (bestScore < this.tol || bestD < 1) {
      this.misses++;
      return { added: 0, total: this.totalH, full: false, miss: true };
    }

    const d = bestD;
    const stride = w * 4;
    this.chunks.push(Buffer.from(buf.subarray((h - d) * stride)));
    this.totalH += d;
    return { added: d, total: this.totalH, full: this.totalH >= this.maxHeight };
  }

  compose() {
    return { buffer: Buffer.concat(this.chunks), width: this.w, height: this.totalH };
  }
}

module.exports = { Stitcher, rowHashes, rowHashesWindow, rowSigsWindow, detectChangedRuns };
