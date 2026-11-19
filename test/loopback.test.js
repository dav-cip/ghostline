import test from 'node:test';
import assert from 'node:assert/strict';
import { Decoder, encodePacket, MODE_LIST } from '../src/modem.js';
import { makePackets, renderTransmission, Reassembler } from '../src/transfer.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const bytes = (n) => Uint8Array.from({ length: n }, () => (rnd() * 256) | 0);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function receive(signal, fs, chunk = 4096) { // feed in small chunks, like a microphone would
  const re = new Reassembler();
  const dec = new Decoder(fs, (p) => re.add(p));
  for (let i = 0; i < signal.length; i += chunk) dec.push(signal.subarray(i, i + chunk));
  return re;
}
const same = (a, b) => assert.deepEqual(Buffer.from(a), Buffer.from(b));

test('clean round trip at 48 kHz', () => {
  const data = bytes(200);
  const re = receive(renderTransmission(makePackets('hello.bin', data, 7), 48000, 1), 48000);
  assert.ok(re.complete);
  const r = re.result();
  assert.equal(r.name, 'hello.bin');
  same(r.data, data);
});

test('works at 44.1 kHz with a random delay before the signal', () => {
  const data = bytes(150);
  const sig = renderTransmission(makePackets('a.txt', data, 9), 44100, 1);
  const padded = new Float32Array(12345 + sig.length);
  padded.set(sig, 12345);
  same(receive(padded, 44100).result().data, data);
});

test('survives background noise', () => {
  const data = bytes(100);
  const sig = renderTransmission(makePackets('n.bin', data, 3), 48000, 2);
  for (let i = 0; i < sig.length; i++) sig[i] += 0.12 * gauss();
  const re = receive(sig, 48000);
  assert.ok(re.complete);
  same(re.result().data, data);
});

test('lost packets are recovered from the second round', () => {
  const data = bytes(300), fs = 48000;
  const packets = makePackets('lossy.bin', data, 5);
  const parts = [];
  for (let round = 0; round < 2; round++) {
    packets.forEach((p, i) => {
      const a = encodePacket(p, fs);
      if (round === 0 && (i === 2 || i === 5)) a.fill(0); // simulate a cough in the room
      parts.push(a);
    });
  }
  const sig = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { sig.set(p, o); o += p.length; }
  const re = receive(sig, fs);
  assert.ok(re.complete);
  same(re.result().data, data);
});

test('empty file and unicode filename', () => {
  const re = receive(renderTransmission(makePackets('café ☕.txt', new Uint8Array(0), 1), 48000, 1), 48000);
  assert.ok(re.complete);
  assert.equal(re.result().data.length, 0);
});

test('survives low-frequency room rumble as loud as the signal', () => {
  const data = bytes(80), fs = 48000;
  const sig = renderTransmission(makePackets('hum.bin', data, 4), fs, 1);
  for (let i = 0; i < sig.length; i++) sig[i] = 0.1 * sig[i] + 0.1 * Math.sin((2 * Math.PI * 120 * i) / fs);
  const re = receive(sig, fs);
  assert.ok(re.complete);
  same(re.result().data, data);
});

test('every range mode round-trips, and a receiver listening for all modes picks the right one', () => {
  const fs = 48000, msg = 'Hi there';
  for (const mode of MODE_LIST) {
    const sig = renderTransmission(makePackets('message.txt', new TextEncoder().encode(msg), 11, mode), fs, 1, mode);
    const pad = new Float32Array(7777 + sig.length); pad.set(sig, 7777);
    const re = new Reassembler(), heard = new Set();
    const dec = new Decoder(fs, (p, m) => { heard.add(m.id); re.add(p, m); }, null, MODE_LIST);
    for (let i = 0; i < pad.length; i += 4096) dec.push(pad.subarray(i, i + 4096));
    assert.ok(re.complete, `${mode.id} did not complete`);
    assert.deepEqual([...heard], [mode.id], `${mode.id}: wrong mode(s) decoded`);
    const r = re.result();
    assert.equal(r.name, 'message.txt');
    assert.equal(new TextDecoder().decode(r.data), msg);
  }
});