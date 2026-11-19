// Acoustic modem: multi-mode FSK, packet framing, CRC-16.
// Pure functions, no browser APIs, so it runs in Node for testing.
//
// A "mode" trades speed for robustness. Echoes in a room last a few hundred ms, so the main lever is symbol
// length: the receiver skips the start of each symbol (where the previous symbol's echo is still ringing)
// and measures only the end. Fewer, wider-spaced tones then make each decision easier.
// Modes with `train` send every tone once after the sync word; the receiver measures each tone's gain from
// that and compensates, which defeats the fading dips a reverberant room puts on individual tones.
// Rule for tone spacing: step (Hz) * measureMs / 1000 must be a whole number of cycles, so tones
// don't leak into each other.

const defs = [
  { id: 'vclose', label: 'Very close', range: '0-30 cm',
    tones: 16, step: 200,  base: 2000, periodMs: 30,  measureMs: 30,  pre: 4, sync: [5, 10, 3, 12],           payload: 32, gapMs: 150, fracMin: 0.12, train: false, pairs: 1 },
  { id: 'close',  label: 'Close',      range: '30 cm-1.5 m',
    tones: 16, step: 200,  base: 2000, periodMs: 200, measureMs: 40,  pre: 4, sync: [5, 10, 3, 12],           payload: 24, gapMs: 250, fracMin: 0.12, train: true,  pairs: 3 },
  { id: 'medium', label: 'Medium',     range: '1.5-3 m',
    tones: 8,  step: 300,  base: 1800, periodMs: 240, measureMs: 40,  pre: 5, sync: [2, 5, 1, 6, 3, 4],       payload: 24, gapMs: 300, fracMin: 0.2,  train: true,  pairs: 3 },
  { id: 'far',    label: 'Far',        range: '3-5 m',
    tones: 4,  step: 500,  base: 1500, periodMs: 250, measureMs: 80,  pre: 6, sync: [1, 2, 0, 3, 1, 3],       payload: 16, gapMs: 400, fracMin: 0.3,  train: true,  pairs: 2 },
  { id: 'vfar',   label: 'Very far',   range: '5 m and beyond',
    tones: 2,  step: 1000, base: 1500, periodMs: 300, measureMs: 100, pre: 8, sync: [0, 0, 1, 1, 0, 1, 0, 0], payload: 12, gapMs: 600, fracMin: 0.45, train: true,  pairs: 1 },
];
export const MODES = Object.fromEntries(defs.map((m) => [m.id, m]));
export const MODE_LIST = defs;
export const DEFAULT_MODE = MODES.vclose;

// Back-compat constants (the original single mode)
export const SYMBOL_MS = DEFAULT_MODE.periodMs;
export const TONE_BASE = DEFAULT_MODE.base;
export const TONE_STEP = DEFAULT_MODE.step;
export const TONES = DEFAULT_MODE.tones;
export const MAX_PAYLOAD = 32; // largest payload any packet may carry (the metadata packet can be bigger than a mode's data chunks)

const RATIO = 1.8; // the preamble tone must beat its complementary tone by this factor (power)
const toneHz = (m, t) => m.base + t * m.step;
const bitsPer = (m) => Math.log2(m.tones);
// Preamble: alternating tone / complementary tone, stepping through `pairs` different pairs so that a single
// faded tone can't hide the packet.
const preambleOf = (m) => Array.from({ length: m.pre * 2 }, (_, i) => { const j = (i >> 1) % (m.pairs || 1); return i % 2 ? m.tones - 1 - j : j; });
export const periodLen = (fs, m = DEFAULT_MODE) => Math.round((fs * m.periodMs) / 1000);
export const symbolLen = periodLen;
export const headSymbols = (m) => m.pre * 2 + m.sync.length + (m.train ? m.tones : 0);

// Seconds of audio for a list of packets in a mode (used by the UI to show an estimate).
export function airtime(packets, mode, rounds = 1) {
  let s = 0.2;
  for (let r = 0; r < rounds; r++) for (const p of packets) {
    s += ((headSymbols(mode) + Math.ceil((p.length * 8) / bitsPer(mode))) * mode.periodMs + mode.gapMs) / 1000;
  }
  return s;
}

// ---------- framing ----------
export function crc16(bytes) {
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

// Packet layout: fileId(1) seq(2) total(2) len(1) payload(len) crc16(2)
export function buildPacket({ fileId, seq, total, payload }) {
  const b = [fileId & 255, seq >> 8, seq & 255, total >> 8, total & 255, payload.length, ...payload];
  const c = crc16(b);
  return Uint8Array.from([...b, c >> 8, c & 255]);
}

export function parsePacket(b) {
  if (b.length < 8) return null;
  const len = b[5];
  if (len > MAX_PAYLOAD || b.length !== 8 + len) return null;
  if (crc16(b.subarray(0, 6 + len)) !== ((b[6 + len] << 8) | b[7 + len])) return null;
  return { fileId: b[0], seq: (b[1] << 8) | b[2], total: (b[3] << 8) | b[4], payload: b.slice(6, 6 + len) };
}

// bytes <-> symbols of `bps` bits each (MSB first). Works for 1, 2, 3 and 4 bits per symbol.
function toSymbols(bytes, bps) {
  const out = []; let acc = 0, n = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; n += 8;
    while (n >= bps) { out.push((acc >> (n - bps)) & ((1 << bps) - 1)); n -= bps; }
    acc &= (1 << n) - 1;
  }
  if (n > 0) out.push((acc << (bps - n)) & ((1 << bps) - 1));
  return out;
}
function fromSymbols(syms, bps, nBytes) {
  const out = new Uint8Array(nBytes); let acc = 0, n = 0, j = 0;
  for (const s of syms) {
    acc = (acc << bps) | s; n += bps;
    while (n >= 8 && j < nBytes) { out[j++] = (acc >> (n - 8)) & 255; n -= 8; }
    acc &= (1 << n) - 1;
  }
  return out;
}

// ---------- transmit ----------
export function encodePacket(bytes, fs, mode = DEFAULT_MODE, gapMs = mode.gapMs) {
  const train = mode.train ? Array.from({ length: mode.tones }, (_, t) => t) : [];
  const syms = [...preambleOf(mode), ...mode.sync, ...train, ...toSymbols(bytes, bitsPer(mode))];
  const N = periodLen(fs, mode);
  const ramp = Math.round(fs * 0.004); // soft edges so speakers don't click
  const out = new Float32Array(syms.length * N + Math.round((fs * gapMs) / 1000));
  syms.forEach((s, k) => {
    const w = (2 * Math.PI * toneHz(mode, s)) / fs;
    for (let i = 0; i < N; i++) {
      const env = Math.min(1, i / ramp, (N - 1 - i) / ramp);
      out[k * N + i] = 0.6 * env * Math.sin(w * i);
    }
  });
  return out;
}

// ---------- receive ----------
function goertzel(x, s, M, c) { // energy of one frequency in a window
  let a = 0, b = 0;
  for (let i = 0; i < M; i++) { const t = x[s + i] + c * a - b; b = a; a = t; }
  return a * a + b * b - c * a * b;
}

class ModeDecoder {
  constructor(fs, mode, onPacket, onSignal) {
    this.mode = mode; this.onPacket = onPacket; this.onSignal = onSignal;
    const N = periodLen(fs, mode), M = Math.min(N, Math.round((fs * mode.measureMs) / 1000));
    this.N = N; this.M = M; this.off = N - M;       // measure the last M samples of each N-sample symbol
    this.T = mode.tones; this.bps = bitsPer(mode);
    this.coef = Array.from({ length: this.T }, (_, t) => 2 * Math.cos((2 * Math.PI * toneHz(mode, t)) / fs));
    this.p = new Float64Array(this.T);
    this.pre = preambleOf(mode); this.sync = mode.sync;
    this.det = this.pre.length + this.sync.length;        // symbols the detector looks at
    this.head = this.det + (mode.train ? this.T : 0);      // ...plus the training tones before the data
    this.gain = new Float64Array(this.T).fill(1); this.eq = false;
    this.preTol = Math.floor(this.pre.length / 4); this.syncTol = Math.floor(this.sync.length / 4);
    this.hdrSyms = Math.ceil(48 / this.bps);        // 6 header bytes
    this.buf = new Float32Array(N * 4); this.len = 0;
    this.known = false;                              // true once buf[0] is a confirmed packet start
    this.scanFrom = 0;                               // positions before this have already been checked and rejected
  }

  push(chunk) {
    const need = this.len + chunk.length;
    if (need > this.buf.length) {
      const nb = new Float32Array(Math.max(need, this.buf.length * 2));
      nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
    }
    this.buf.set(chunk, this.len); this.len = need;
    this.#scan();
  }

  #drop(k) { if (k > 0) { this.scanFrom = Math.max(0, this.scanFrom - k); this.buf.copyWithin(0, k, this.len); this.len -= k; } }

  #powers(x, o) { // fills this.p with each tone's energy in the window at o; returns the in-band total
    let tot = 0;
    for (let t = 0; t < this.T; t++) { const v = goertzel(x, o, this.M, this.coef[t]); this.p[t] = v; tot += v; }
    return tot;
  }

  #classify(x, o) { // which tone is loudest, and what share of the in-band energy it holds
    let tot = this.#powers(x, o);
    if (this.eq) { tot = 0; for (let t = 0; t < this.T; t++) { this.p[t] /= this.gain[t]; tot += this.p[t]; } }
    let sym = 0;
    for (let t = 1; t < this.T; t++) if (this.p[t] > this.p[sym]) sym = t;
    return { sym, frac: this.p[sym] / (tot + 1e-12) };
  }

  #score(x, s) { // does a preamble + sync word start here? Tolerates a few bad symbols: in a reverberant
    const { N, off, T } = this, fm = this.mode.fracMin; // room the echo of the previous tone smears some of them
    let score = 0, preMiss = 0, syncMiss = 0;
    for (let k = 0; k < this.det; k++) {
      const o = s + k * N + off;
      if (k < this.pre.length) {
        const e = this.pre[k], pe = goertzel(x, o, this.M, this.coef[e]), po = goertzel(x, o, this.M, this.coef[T - 1 - e]);
        let frac = 0; // cheap two-tone check first; the full in-band total only for plausible candidates
        if (pe >= RATIO * po) { this.#powers(x, o); frac = pe / (this.p.reduce((a, b) => a + b, 0) + 1e-12); }
        if (frac < fm) { if (++preMiss > this.preTol) return 0; } else score += frac;
      } else {
        const c = this.#classify(x, o);
        if (c.sym !== this.sync[k - this.pre.length] || c.frac < fm) { if (++syncMiss > this.syncTol) return 0; } else score += c.frac;
      }
    }
    return score;
  }

  #find(x, to) {
    const { N, off } = this, step = Math.max(1, N >> 3), fine = Math.max(1, N >> 5);
    let s = this.scanFrom;
    for (; s <= to; s += step) {
      if (!this.#score(x, s)) continue;
      this.scanFrom = 0;
      const lo = Math.max(0, s - step), hi = s + Math.floor(N * 0.7);
      if (hi > to) return { s, wait: true }; // the audio that shows where the best alignment is hasn't all arrived yet
      const pos = [], sc = []; let top = 0;
      for (let r = lo; r <= hi; r += fine) { const v = this.#score(x, r); pos.push(r); sc.push(v); if (v > top) top = v; }
      // With a short measuring window there is a plateau of equally good offsets. Take the late edge of
      // it (window at the end of the symbol, past the echo) and back off a little to tolerate clock drift.
      let best = pos[sc.indexOf(top)];
      for (let i = sc.length - 1; i >= 0; i--) if (sc[i] >= 0.93 * top) { best = pos[i]; break; }
      return { s: Math.max(0, best - Math.round(0.25 * off)), wait: false };
    }
    this.scanFrom = s;
    return { s: -1, wait: false };
  }

  #estimateGains(x, s) { // how strongly did each tone arrive during the training symbols?
    if (!this.mode.train) return;
    const base = s + this.det * this.N + this.off;
    let mx = 0;
    for (let t = 0; t < this.T; t++) { const v = goertzel(x, base + t * this.N, this.M, this.coef[t]); this.gain[t] = v; if (v > mx) mx = v; }
    for (let t = 0; t < this.T; t++) this.gain[t] = Math.max(this.gain[t], 0.03 * mx, 1e-12); // never boost a dead tone by more than ~15 dB
  }

  #bytes(x, body, nSyms, nBytes) {
    const syms = new Array(nSyms);
    this.eq = !!this.mode.train;
    for (let i = 0; i < nSyms; i++) syms[i] = this.#classify(x, body + i * this.N + this.off).sym;
    this.eq = false;
    return fromSymbols(syms, this.bps, nBytes);
  }

  #scan() {
    const { N } = this;
    for (;;) {
      const x = this.buf, len = this.len;
      let s = 0;
      if (!this.known) {
        const f = this.#find(x, len - this.det * N);
        if (f.wait) { this.#drop(Math.max(0, f.s - Math.max(1, N >> 3))); return; }
        s = f.s;
        if (s < 0) { this.#drop(Math.max(0, len - (this.det + 1) * N)); return; }
      }
      this.onSignal?.(this.mode); // preamble + sync recognised: a real packet is arriving
      const body = s + this.head * N;
      if (len < body + this.hdrSyms * N) { this.#drop(s); this.known = true; return; } // wait for header
      this.#estimateGains(x, s);
      const plen = this.#bytes(x, body, this.hdrSyms, 6)[5];
      if (plen > MAX_PAYLOAD) { this.#drop(s + N); this.known = false; continue; }
      const nSyms = Math.ceil(((8 + plen) * 8) / this.bps), end = body + nSyms * N;
      if (len < end) { this.#drop(s); this.known = true; return; }                     // wait for the rest
      const pkt = parsePacket(this.#bytes(x, body, nSyms, 8 + plen));
      if (pkt) { this.onPacket(pkt); this.#drop(end); } else this.#drop(s + N);
      this.known = false;
    }
  }
}

// Decodes one or several modes at once. With several, whichever mode's preamble is heard locks on.
export class Decoder {
  constructor(fs, onPacket, onSignal, modes = [DEFAULT_MODE]) {
    this.subs = modes.map((m) => new ModeDecoder(fs, m, (p) => onPacket(p, m), onSignal));
  }
  push(chunk) { for (const d of this.subs) d.push(chunk); }
}