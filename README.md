# PN532 Studio — Windows desktop console for USB-powered PN532 v2.0 (HSU) module v3

Production-ready Electron + Vite + React 19 + TypeScript app for the Elechouse-style
**PN532 NFC/RFID Module V3** (USB-powered, HSU/UART mode). UI tokens and core
components come from **[opendraft UI System](https://ui-system-virid.vercel.app/)**
(`button`, `card`, theme) — styled **only with tokens**, light + dark.

## What it does (v1)

- **Reader dashboard** — serial connect @115200, `GetFirmwareVersion`, `SAMConfiguration`,
  `InListPassiveTarget` poll once / auto-poll, UID/SAK/type display.
- **Tag read/write + NDEF** — MIFARE Classic auth/read/write (trailer blocks protected),
  NTAG/Ultralight 4-byte page read/write (pages 0–3 locked), NDEF Text/URI decode,
  and NDEF **write** (Text / Number / URL records with capacity check + read-back verify).
- **APDU console + logs** — raw PN532 command send, full HSU TX/RX frame trace, export-friendly log.
- **Scan & view** — tap-to-read module: text/numbers display inline, URL records
  trigger a permission modal (full URL + domain, safe-default focus, Esc/backdrop
  denies, asked once per tag) before opening in the browser via an http(s)-only
  main-process opener.
- **Mock device** — explore all screens without hardware (`Mock device` port).

## Hardware wiring (Elechouse PN532 V3, USB-powered)

1. Set interface switches to **HSU / UART** (check silkscreen S1/S2; default is HSU on V3/V4).
2. Connect via USB-serial (module's onboard USB or external CH340/CP2102):
   `VCC→5V · GND→GND · TX→RX · RX→TX`. USB powers the board.
3. Windows: install CH340/CP210x driver if COM port doesn't appear; use Device Manager to find `COMn`.
4. Hold tag **1–3 cm** from antenna for poll/read/write.

## Quickstart

```powershell
npm install
npm run dev        # Electron + Vite HMR
npm test           # vitest: HSU frames, NDEF
npm run lint       # tsc web + node
npm run build      # out/
npm run dist:win   # NSIS setup + portable .exe in release/
```

No `gh` CLI needed. To publish later:

```powershell
git init; git add -A; git commit -m "feat: pn532 studio v1"
gh repo create pn532-studio --public --source=. --push
# or: create empty repo on github.com, then
git remote add origin https://github.com/<you>/pn532-studio.git
git push -u origin main
```

## Troubleshooting: "PN532 is silent / did not answer"

The port opened but the module sent back 0 bytes. Work through this order:

1. **Right COM port?** In Device Manager → Ports, unplug the USB-TTL adapter and
   see which COM disappears. Replug, pick that one. Do NOT pick modem/Bluetooth
   ports (e.g. Intel AMT SOL). Install the adapter driver (CH340 / CP210x / PL2303)
   if no new COM appears.
2. **HSU mode?** Set BOTH DIP switches **OFF** (HSU per the Elechouse V3 manual;
   I2C = CH1 ON, SPI = CH2 ON). Then **power-cycle the module** — the interface
   is latched at power-up, flipping switches live does nothing. HSU shares pins
   with I2C: use the **TXD/RXD** labels (printed on the back of some boards).
3. **Wiring (must be crossed + common ground):** adapter **TX → module RX**,
   adapter **RX → module TX**, **GND → GND**. Straight TX→TX/RX→RX is the #1
   wiring mistake and gives exactly this silence.
4. **Power:** feed VCC (5V, or 3.3V) + GND from the adapter/USB. The app sends a
   libnfc-style HSU wake-up pulse (`55 55 00…`), retries 3×, and falls back
   115200 → 57600 automatically, so a silent module is a hardware-side issue.
5. Still silent? Try another USB cable/port, another adapter, and confirm with a
   loopback test (short adapter TX to RX — typed characters should echo in a
   serial terminal) to rule out a dead adapter.

## Protocol notes

HSU frame: `00 00 FF LEN LCS [D4 CMD …] DCS 00`; ACK `00 00 FF 00 FF 00`.
See `src/shared/pn532/` (`frame.ts`, `commands.ts`, `ndef.ts`) and NXP PN532/C1 manual.

## Safety

- Never writes MIFARE sector trailers or NTAG pages 0–3 from the UI.
- Writes are explicit button clicks with auth; no auto-write loop.

## License

MIT. opendraft components vendored per-file (MIT) with source URLs in file headers.
