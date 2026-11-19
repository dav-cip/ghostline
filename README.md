# ghostline

Send a message or small file between two devices using **only sound**. No Wi-Fi, no Bluetooth, no cable. A from-scratch acoustic modem in about 200 lines of dependency-free JavaScript, in the spirit of the 1980s modems and cassette-tape loaders.

## Try it

```bash
npm test          # modem round-trip tests (Node 18+)
npx serve .       # then open http://localhost:3000/web/
```

Open the page on two devices (or two browser tabs on one machine). One taps **Play as sound**, the other taps **Start listening**. The microphone needs `https://` or `localhost`. GitHub Pages works.

Pick a **Range** on the sender that matches the distance between the devices. The receiver auto-detects which one is playing. Tips: volume at about 70%, quiet room, and avoid Bluetooth speakers (they add delay and compress the audio).

## How it works

| Layer | What it does | File |
|---|---|---|
| Modulation | FSK with 2 to 16 tones between 1.5 and 5 kHz, depending on the range mode (see below) | `src/modem.js` |
| Detection | Goertzel filters measure each tone's energy; an alternating-tone preamble plus a sync word finds where a packet starts | `src/modem.js` |
| Framing | `fileId, seq, total, len, payload, CRC-16` per packet; payload is 12 to 32 bytes depending on mode | `src/modem.js` |
| Reliability | One-way channel, so the sender repeats the whole file in *rounds* and the receiver keeps any valid packet it missed the first time | `src/transfer.js` |
| Interface | Live spectrogram, packet progress grid, download link | `web/` |

Design choices worth knowing:
- Tone spacing (200 Hz) times symbol length (30 ms) is exactly 6 cycles, so tones don't leak into each other at any sample rate.
- Every packet is self-contained, so a dropped packet costs one packet, not the whole file.
- The microphone is opened with echo cancellation, noise suppression and auto-gain **off**. Browsers treat sustained tones as noise otherwise.

## Range modes

Echoes are the main enemy: in a room, the previous symbol is still ringing when the next one starts. The receiver skips the start of each symbol and measures only the end, so the longer the symbols, the more echo it can ride out. Slower modes also use fewer, wider-spaced tones, and every mode except Very close sends a short training sequence (each tone once) so the receiver can compensate for tones that the room fades.

| Mode | Symbol | Tones | Meant for | Throughput (approx.) |
|---|---|---|---|---|
| Very close | 30 ms | 16 | 0-30 cm | 11 bytes/s |
| Close | 200 ms | 16 | 30 cm-1.5 m | 1.3 bytes/s |
| Medium | 240 ms | 8 | 1.5-3 m | 0.9 bytes/s |
| Far | 250 ms | 4 | 3-5 m | 0.5 bytes/s |
| Very far | 300 ms | 2 | 5 m and beyond | 0.2 bytes/s |

The ranges come from a simulated reverberant room (RT60 0.5 s) plus reasoning, not from measurements in real rooms. Treat them as starting points: if a mode fails at its stated distance, move up one mode.

## Limits

This is for messages and tiny files: 1 KB takes about 90 s per round in Very close mode and far longer in the others. Files over about 2 MB are not supported by the packet header.

## Ideas to extend it

- Compression (`CompressionStream`) before sending
- Reed-Solomon forward error correction instead of whole-file repeats
- Faster modes: 32 tones, shorter symbols, ultrasonic band for quieter transfers
- A CLI sender/receiver using a Node audio library
- A retro terminal skin with an authentic modem handshake

## License

MIT