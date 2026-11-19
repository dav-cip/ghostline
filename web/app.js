import { Decoder, MODES, MODE_LIST, airtime, headSymbols } from '../src/modem.js';
import { makePackets, renderTransmission, Reassembler } from '../src/transfer.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const BAND_LO = Math.min(...MODE_LIST.map((m) => m.base)) - 200;                      // the frequencies the modes use
const BAND_HI = Math.max(...MODE_LIST.map((m) => m.base + m.tones * m.step)) + 200;

let ctx, analyser;
let listening = false, lastHeard = 0, lastLock = 0; // timestamps (ms) for the receiver indicator
let onFrame = null;

function setPill(id, state, text) { const el = $(id); el.dataset.state = state; el.textContent = text; }

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    draw();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ---- spectrogram + level meter (one animation loop) ----
function draw() {
  const c = $('spec'), g = c.getContext('2d'), H = c.height, W = c.width;
  const data = new Uint8Array(analyser.frequencyBinCount);
  g.fillStyle = css('--lcd'); g.fillRect(0, 0, W, H);
  (function frame() {
    analyser.getByteFrequencyData(data);
    const binHz = ctx.sampleRate / analyser.fftSize, lo = BAND_LO / binHz, hi = BAND_HI / binHz;
    g.drawImage(c, -2, 0);
    g.fillStyle = css('--lcd'); g.fillRect(W - 2, 0, 2, H);
    g.fillStyle = css('--trace');
    let peak = 0;
    for (let y = 0; y < H; y++) {
      const v = data[Math.round(hi - (y / H) * (hi - lo))] / 255;
      if (v > peak) peak = v;
      if (v > 0.35) { g.globalAlpha = Math.min(1, (v - 0.35) * 1.8); g.fillRect(W - 2, y, 2, 1); }
    }
    g.globalAlpha = 1;
    onFrame?.(peak, performance.now());
    requestAnimationFrame(frame);
  })();
}


// ---- range modes ----
$('mode').innerHTML = MODE_LIST.map((m) => `<option value="${m.id}">${m.label} (${m.range})</option>`).join('');
$('mode').value = 'close';
$('rmode').innerHTML = '<option value="auto">Auto-detect (any range)</option>' + MODE_LIST.map((m) => `<option value="${m.id}">${m.label} only</option>`).join('');

function messageBytes() { // size of what will be sent, for the time estimate
  const f = $('file').files[0];
  return f ? f.size : new TextEncoder().encode($('text').value).length;
}
function updateModeInfo() {
  const m = MODES[$('mode').value], size = messageBytes(), rounds = +$('rounds').value;
  const perPacket = ((headSymbols(m) + Math.ceil(((8 + m.payload) * 8) / Math.log2(m.tones))) * m.periodMs + m.gapMs) / 1000;
  const rate = m.payload / perPacket;
  let est = '';
  if (size > 0 && size <= 20000) {
    const secs = airtime(makePackets('message.txt', new Uint8Array(size), 0, m), m, rounds);
    est = ` This message: about ${secs < 90 ? Math.round(secs) + ' s' : (secs / 60).toFixed(1) + ' min'}.`;
  }
  $('modeInfo').textContent = `Best at ${m.range}. ${m.tones} tones, ${m.periodMs} ms per symbol, about ${rate < 2 ? rate.toFixed(1) : Math.round(rate)} bytes per second.${est}`;
}
['mode', 'rounds', 'text', 'file'].forEach((id) => $(id).addEventListener(id === 'text' ? 'input' : 'change', updateModeInfo));
updateModeInfo();

// ---- send: live progress while the sound plays ----
$('send').onclick = async () => {
  const actx = audio(), file = $('file').files[0];
  let name, data;
  if (file) { name = file.name; data = new Uint8Array(await file.arrayBuffer()); }
  else { name = 'message.txt'; data = new TextEncoder().encode($('text').value); }
  if (!data.length) { $('sendDetail').textContent = 'Type a message or choose a file first.'; return; }
  const mode = MODES[$('mode').value], rounds = +$('rounds').value;
  const packets = makePackets(name, data, undefined, mode);
  const samples = renderTransmission(packets, actx.sampleRate, rounds, mode);
  const total = samples.length / actx.sampleRate;
  if (total > 600) { $('sendDetail').textContent = `That would take ${Math.round(total)} seconds. Try a smaller file.`; return; }

  const buf = actx.createBuffer(1, samples.length, actx.sampleRate);
  buf.copyToChannel(samples, 0);
  const src = actx.createBufferSource();
  src.buffer = buf; src.connect(actx.destination); src.connect(analyser);
  const t0 = actx.currentTime + 0.05;
  src.start(t0);
  const all = packets.length * rounds;

  setPill('sendPill', 'active', `Sending sound (${mode.label})`);
  const tick = () => {
    const frac = Math.min(1, Math.max(0, (actx.currentTime - t0) / total));
    $('sendBar').style.width = `${frac * 100}%`;
    const i = Math.min(all, Math.floor(frac * all) + 1); // approximate: packets are near-equal length
    $('sendDetail').textContent = `Packet ${((i - 1) % packets.length) + 1} of ${packets.length}, round ${Math.ceil(i / packets.length)} of ${rounds}`;
    if (frac < 1) requestAnimationFrame(tick);
  };
  tick();
  src.onended = () => { setPill('sendPill', 'done', 'Sent'); $('sendBar').style.width = '100%'; $('sendDetail').textContent = `Finished playing ${all} packets.`; };
};

// ---- receive: live signal indicator ----
let stopListening = null, heardMode = null;

onFrame = (peak, now) => {
  if (!listening) return;
  $('meterBar').style.width = `${Math.min(100, peak * 110)}%`;
  if (peak > 0.55) lastHeard = now;
  if ($('recvPill').dataset.state === 'done') return;
  if (now - lastLock < 900) setPill('recvPill', 'active', 'Receiving data');
  else if (now - lastHeard < 600) setPill('recvPill', 'hearing', 'Sound detected, locking on...');
  else setPill('recvPill', 'idle', 'Listening, waiting for sound');
};

function showGrid(re) {
  const grid = $('grid');
  if (grid.children.length !== re.total) grid.innerHTML = '<i></i>'.repeat(re.total);
  [...grid.children].forEach((el, i) => el.classList.toggle('got', re.parts.has(i)));
  $('recvDetail').textContent = `Heard ${re.have} of ${re.total} packets` + (heardMode ? ` (${heardMode.label} mode)` : '');
}

// Live view: rebuild the text from whatever packets have arrived so far. Missing chunks show as blocks.
function showLive(re) {
  const live = $('live'), td = new TextDecoder();
  live.hidden = false;
  const meta = re.parts.get(0);
  if (meta) {
    const name = meta[0] ? td.decode(meta.slice(1, 1 + meta[0])) : 'message.txt';
    if (!/\.(txt|md|json)$/i.test(name)) { live.textContent = `(${name} is not a text file: ${re.have} of ${re.total} packets so far)`; return; }
  }
  let out = '', run = [];
  const flush = () => {
    if (!run.length) return;
    const m = new Uint8Array(run.reduce((a, r) => a + r.length, 0)); let o = 0;
    for (const r of run) { m.set(r, o); o += r.length; }
    out += td.decode(m); run = [];
  };
  for (let q = 1; q < re.total; q++) { const part = re.parts.get(q); if (part) run.push(part); else { flush(); out += '\u2592\u2592\u2592'; } }
  flush();
  live.textContent = out || '(waiting for message data...)';
}

function showResult(re) {
  const { name, data } = re.result();
  const url = URL.createObjectURL(new Blob([data]));
  $('out').innerHTML = '';
  $('out').append(Object.assign(document.createElement('a'), { href: url, download: name, className: 'dl', textContent: `Save ${name} (${data.length} bytes)` }));
  if (/\.(txt|md|json)$/i.test(name)) { const pre = document.createElement('pre'); pre.textContent = new TextDecoder().decode(data); $('out').append(pre); }
  setPill('recvPill', 'done', 'Complete: file received');
}

$('listen').onclick = async () => {
  const actx = audio();
  let stream;
  try {
    // Turn off the browser's voice processing, or it will treat our tones as noise.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch { setPill('recvPill', 'idle', 'Microphone blocked'); $('recvDetail').textContent = 'Allow microphone access and try again. It needs https or localhost.'; return; }
  try { await actx.resume(); } catch { }
  if (actx.state !== 'running') { setPill('recvPill', 'idle', 'Audio engine not running'); $('recvDetail').textContent = 'Tap Start listening again.'; stream.getTracks().forEach((t) => t.stop()); return; }
  const re = new Reassembler(); let done = false;
  const dec = new Decoder(actx.sampleRate,
    (p, m) => { pkts++; heardMode = m; re.add(p, m); showGrid(re); showLive(re); if (re.complete && !done) { done = true; showResult(re); } },
    (m) => { locks++; lastLock = performance.now(); lockMode = m; },
    $('rmode').value === 'auto' ? MODE_LIST : [MODES[$('rmode').value]]);
  let mic, proc, mute;
  try { mic = actx.createMediaStreamSource(stream); } catch (e) { setPill('recvPill', 'idle', 'Microphone unusable'); $('recvDetail').textContent = String(e.message || e); stream.getTracks().forEach((t) => t.stop()); return; }
  proc = actx.createScriptProcessor(4096, 1, 1); mute = actx.createGain();
  mute.gain.value = 0;
  let blocks = 0, mx = 0, pkts = 0, locks = 0, lockMode = null;
  const track = stream.getAudioTracks()[0], st = track ? track.getSettings() : {};
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0); blocks++;
    for (let i = 0; i < d.length; i += 8) { const a = Math.abs(d[i]); if (a > mx) mx = a; }
    dec.push(new Float32Array(d));
  };
  const dbgTimer = setInterval(() => {
    $('dbg').textContent = `ctx ${actx.state} ${actx.sampleRate}Hz | mic ${st.sampleRate || '?'}Hz ${track ? track.readyState : 'no track'}${track && track.muted ? ' MUTED' : ''} | blocks ${blocks} | peak ${mx.toFixed(4)} | locks ${locks}${lockMode ? ' (' + lockMode.label + ')' : ''} | packets ${pkts}`;
    mx = 0;
  }, 500);
  mic.connect(analyser); mic.connect(proc); proc.connect(mute); mute.connect(actx.destination);
  listening = true; lastHeard = lastLock = 0; heardMode = null;
  $('listen').disabled = true; $('stop').disabled = false; $('grid').innerHTML = ''; $('out').innerHTML = ''; $('live').hidden = true;
  setPill('recvPill', 'idle', 'Listening, waiting for sound');
  stopListening = () => {
    listening = false; clearInterval(dbgTimer); stream.getTracks().forEach((t) => t.stop()); proc.disconnect(); mic.disconnect();
    $('listen').disabled = false; $('stop').disabled = true; $('meterBar').style.width = '0';
    setPill('recvPill', 'idle', 'Not listening'); $('recvDetail').textContent = 'Signal level';
  };
};
$('stop').onclick = () => stopListening?.();
