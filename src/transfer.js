// File <-> packets. Every packet carries its own sequence number, so the sender can
// play the whole file several times ("rounds") and the receiver fills in whatever it missed.
import { buildPacket, encodePacket, MAX_PAYLOAD, DEFAULT_MODE } from './modem.js';

const enc = new TextEncoder(), dec = new TextDecoder();

// Packet 0 = metadata (name + size). Packets 1..n = file data, `mode.payload` bytes each.
// A name of 'message.txt' is sent as an empty name (saves 11 bytes, which matters in the slow modes).
export const DEFAULT_NAME = 'message.txt';
export function makePackets(name, data, fileId = (Math.random() * 256) | 0, mode = DEFAULT_MODE) {
  let n = name === DEFAULT_NAME ? '' : name;
  while (enc.encode(n).length > 20) n = n.slice(0, -1);
  const nb = enc.encode(n), size = data.length, chunk = mode.payload;
  const meta = Uint8Array.from([nb.length, ...nb, (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255]);
  const total = Math.ceil(size / chunk) + 1;
  const packets = [buildPacket({ fileId, seq: 0, total, payload: meta })];
  for (let i = 1; i < total; i++) {
    packets.push(buildPacket({ fileId, seq: i, total, payload: data.subarray((i - 1) * chunk, i * chunk) }));
  }
  return packets;
}

function sweep(fs) { // cosmetic "modem handshake" chirp. The receiver ignores it.
  const n = Math.round(fs * 0.5), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    out[i] = 0.3 * Math.sin(2 * Math.PI * (900 * t + 3000 * t * t)) * Math.min(1, i / 200, (n - i) / 200);
  }
  return out;
}

export function renderTransmission(packets, fs, rounds = 2, mode = DEFAULT_MODE) {
  const parts = [new Float32Array(Math.round(fs * 0.2))];
  for (let r = 0; r < rounds; r++) for (const p of packets) parts.push(encodePacket(p, fs, mode));
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class Reassembler {
  constructor() { this.payload = MAX_PAYLOAD; this.reset(); }
  reset() { this.fileId = null; this.total = 0; this.parts = new Map(); }
  add(p, mode) {
    if (mode) this.payload = mode.payload;
    if (p.fileId !== this.fileId || p.total !== this.total) { this.reset(); this.fileId = p.fileId; this.total = p.total; }
    if (p.seq < this.total) this.parts.set(p.seq, p.payload);
    return this;
  }
  get have() { return this.parts.size; }
  get complete() { return this.total > 0 && this.parts.size === this.total; }
  result() {
    const meta = this.parts.get(0), nl = meta[0];
    const name = nl ? dec.decode(meta.slice(1, 1 + nl)) : DEFAULT_NAME;
    const o = 1 + nl;
    const size = ((meta[o] << 24) | (meta[o + 1] << 16) | (meta[o + 2] << 8) | meta[o + 3]) >>> 0;
    const data = new Uint8Array(size);
    for (let s = 1; s < this.total; s++) data.set(this.parts.get(s), (s - 1) * this.payload);
    return { name, data };
  }
}