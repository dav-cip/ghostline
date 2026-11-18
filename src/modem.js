// Acoustic modem: 16-tone FSK (4 bits per symbol), packet framing, CRC-16.
// Pure functions, no browser APIs, so it runs in Node for testing.

export const SYMBOL_MS = 30;
export const TONE_BASE = 2000; // Hz
export const TONE_STEP = 200;  // Hz. 200 Hz * 30 ms = 6 whole cycles, so tones stay orthogonal
export const TONES = 16;
export const MAX_PAYLOAD = 32;

const PREAMBLE = [0, 15, 0, 15, 0, 15, 0, 15]; // alternating tones: "something is coming"
const SYNC = [5, 10, 3, 12];                  // unique pattern: "it starts here"
const HEAD = PREAMBLE.length + SYNC.length;
const toneHz = (t) => TONE_BASE + t * TONE_STEP;
export const symbolLen = (fs) => Math.round((fs * SYMBOL_MS) / 1000);

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

// ---------- transmit ----------
export function encodePacket(bytes, fs, gapMs = 150) {
  const syms = [...PREAMBLE, ...SYNC];
  for (const v of bytes) syms.push(v >> 4, v & 15);
  const N = symbolLen(fs);
  const ramp = Math.round(fs * 0.004); // soft edges so speakers don't click
  const out = new Float32Array(syms.length * N + Math.round((fs * gapMs) / 1000));
  syms.forEach((s, k) => {
    const w = (2 * Math.PI * toneHz(s)) / fs;
    for (let i = 0; i < N; i++) {
      const env = Math.min(1, i / ramp, (N - 1 - i) / ramp);
      out[k * N + i] = 0.6 * env * Math.sin(w * i);
    }
  });
  return out;
}

// ---------- receive ----------
function power(x, s, N, fs, hz) { // Goertzel: energy of one frequency in a window
  const c = 2 * Math.cos((2 * Math.PI * hz) / fs);
  let a = 0, b = 0;
  for (let i = 0; i < N; i++) { const t = x[s + i] + c * a - b; b = a; a = t; }
  return a * a + b * b - c * a * b;
}
// In-band energy: total Goertzel power over the 16 tone bins. Using full-band energy instead lets
// room rumble / hum / handling noise below 2 kHz swamp the "is this a pure tone?" test.
function energy(x, s, N, fs) {
  let e = 0;
  for (let t = 0; t < TONES; t++) e += power(x, s, N, fs, toneHz(t));
  return e / N; // Parseval: per-bin power / N ~ time-domain energy of that bin
}

function classify(x, s, N, fs) { // which of the 16 tones is loudest, and how "pure" is it
  let sym = 0, best = -1;
  for (let t = 0; t < TONES; t++) {
    const p = power(x, s, N, fs, toneHz(t));
    if (p > best) { best = p; sym = t; }
  }
  return { sym, frac: best / (N * energy(x, s, N, fs) + 1e-12) }; // a pure tone gives 0.5
}

function scoreAt(x, s, N, fs) { // does a preamble + sync word start exactly here?
  let score = 0;
  for (let k = 0; k < HEAD; k++) {
    const o = s + k * N;
    if (k < PREAMBLE.length) {
      const e = PREAMBLE[k];
      const pe = power(x, o, N, fs, toneHz(e));
      const po = power(x, o, N, fs, toneHz(TONES - 1 - e));
      const frac = pe / (N * energy(x, o, N, fs) + 1e-12);
      if (pe < 4 * po || frac < 0.12) return 0; // cheap early exit for non-packets
      score += frac;
    } else {
      const c = classify(x, o, N, fs);
      if (c.sym !== SYNC[k - PREAMBLE.length] || c.frac < 0.12) return 0;
      score += c.frac;
    }
  }
  return score;
}

function findStart(x, to, N, fs) {
  const step = Math.max(1, N >> 3), fine = Math.max(1, N >> 5);
  for (let s = 0; s <= to; s += step) {
    if (!scoreAt(x, s, N, fs)) continue;
    let best = s, bs = 0; // refine: the best-aligned offset scores highest
    for (let r = Math.max(0, s - step); r <= Math.min(to, s + Math.floor(N * 0.7)); r += fine) {
      const sc = scoreAt(x, r, N, fs);
      if (sc > bs) { bs = sc; best = r; }
    }
    return best;
  }
  return -1;
}

export class Decoder {
  constructor(fs, onPacket, onSignal) {
    this.fs = fs; this.N = symbolLen(fs); this.onPacket = onPacket; this.onSignal = onSignal;
    this.buf = new Float32Array(0);
  }

  push(chunk) {
    const nb = new Float32Array(this.buf.length + chunk.length);
    nb.set(this.buf); nb.set(chunk, this.buf.length);
    this.buf = nb;
    this.#scan();
  }

  #bytes(x, s, nSyms) {
    const { N, fs } = this;
    const out = new Uint8Array(nSyms >> 1);
    for (let i = 0; i < nSyms; i += 2) {
      const hi = classify(x, s + i * N, N, fs).sym, lo = classify(x, s + (i + 1) * N, N, fs).sym;
      out[i >> 1] = (hi << 4) | lo;
    }
    return out;
  }

  #scan() {
    const { N, fs } = this;
    for (;;) {
      const x = this.buf, len = x.length;
      const s = findStart(x, len - HEAD * N, N, fs);
      if (s < 0) { this.buf = x.slice(Math.max(0, len - (HEAD + 1) * N)); return; }
      this.onSignal?.(); // preamble + sync recognised: a real packet is arriving
      const body = s + HEAD * N;
      if (len < body + 12 * N) { this.buf = x.slice(s); return; } // wait for header
      const plen = this.#bytes(x, body, 12)[5];
      if (plen > MAX_PAYLOAD) { this.buf = x.slice(s + N); continue; }
      const nSyms = (6 + plen + 2) * 2, end = body + nSyms * N;
      if (len < end) { this.buf = x.slice(s); return; }   // wait for the rest
      const pkt = parsePacket(this.#bytes(x, body, nSyms));
      if (pkt) { this.onPacket(pkt); this.buf = x.slice(end); } else this.buf = x.slice(s + N);
    }
  }
}