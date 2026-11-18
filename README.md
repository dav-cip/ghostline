# ghostline

Send a message or small file between two devices using **only sound**. No Wi-Fi, no Bluetooth, no cable. A from-scratch acoustic modem in about 200 lines of dependency-free JavaScript, in the spirit of the 1980s modems and cassette-tape loaders.

## Try it

```bash
npm test          # modem round-trip tests (Node 18+)
npx serve .       # then open http://localhost:3000/web/
```

Open the page on two devices (or two browser tabs on one machine). One taps **Play as sound**, the other taps **Start listening**. The microphone needs `https://` or `localhost`. GitHub Pages works.

Tips: volume at about 70%, quiet room, devices 10-50 cm apart, and avoid Bluetooth speakers (they add delay and compress the audio).

## How it works

| Layer | What it does | File |
|---|---|---|
| Modulation | 16-tone FSK, 2.0 to 5.0 kHz, 30 ms per symbol, 4 bits per symbol (about 130 bits/s) | `src/modem.js` |
| Detection | Goertzel filters measure each tone's energy; an alternating-tone preamble plus a sync word finds where a packet starts | `src/modem.js` |
| Framing | `fileId, seq, total, len, payload (32 B max), CRC-16` per packet | `src/modem.js` |
| Reliability | One-way channel, so the sender repeats the whole file in *rounds* and the receiver keeps any valid packet it missed the first time | `src/transfer.js` |
| Interface | Live spectrogram, packet progress grid, download link | `web/` |

Design choices worth knowing:
- Tone spacing (200 Hz) times symbol length (30 ms) is exactly 6 cycles, so tones don't leak into each other at any sample rate.
- Every packet is self-contained, so a dropped packet costs one packet, not the whole file.
- The microphone is opened with echo cancellation, noise suppression and auto-gain **off**. Browsers treat sustained tones as noise otherwise.

## Limits

About 12 bytes per second, so this is for messages and tiny files (1 KB takes around 80 s per round). Files over about 2 MB are not supported by the packet header.

## Ideas to extend it

- Compression (`CompressionStream`) before sending
- Reed-Solomon forward error correction instead of whole-file repeats
- Faster modes: 32 tones, shorter symbols, ultrasonic band for quieter transfers
- A CLI sender/receiver using a Node audio library
- A retro terminal skin with an authentic modem handshake

## License

MIT
