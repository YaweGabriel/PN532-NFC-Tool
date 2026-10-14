import { SerialPort } from 'serialport'
import { encodeCommand, tryDecodeOne, ACK_FRAME, type DecodedFrame } from '../../src/shared/pn532/frame.js'
import { CMD, parseFirmwareVersion, samConfigParams, inListPassiveTargetParams, mifareAuthParams } from '../../src/shared/pn532/commands.js'

export interface LogEntry {
  id: number
  ts: string
  dir: 'tx' | 'rx' | 'info' | 'error'
  label: string
  hex?: string
}

export interface TargetInfo {
  found: boolean
  at?: string
  uid?: string
  sak?: string
  ats?: string
  type?: string
  raw?: string
}

export interface StatusInfo {
  connected: boolean
  mock: boolean
  port: string | null
  baud: number
  firmware: string | null
  lastTarget: TargetInfo | null
}

const MOCK_FIRMWARE = { ic: 0x32, ver: 1, rev: 6, support: 7 }

export class Pn532Service {
  private port: SerialPort | null = null
  private portPath: string | null = null
  private baud = 115200
  private rxBuf: number[] = []
  private waiters: Array<{ resolve: (f: DecodedFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; wantCmd?: number }> = []
  private logSeq = 0
  private logCb: ((e: LogEntry) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private firmware: string | null = null
  private lastTarget: TargetInfo | null = null
  private mock = false
  private rxTotal = 0

  onLog(cb: (e: LogEntry) => void) {
    this.logCb = cb
  }

  private log(dir: LogEntry['dir'], label: string, hex?: string) {
    const entry: LogEntry = { id: ++this.logSeq, ts: new Date().toISOString(), dir, label, hex }
    this.logCb?.(entry)
  }

  async listPorts(): Promise<Array<{ path: string; manufacturer?: string; friendly?: string }>> {
    try {
      const ports = await SerialPort.list()
      return ports.map((p) => {
        const extra = p as unknown as Record<string, string | undefined>
        return {
          path: p.path,
          manufacturer: p.manufacturer,
          friendly: extra['friendlyName'] ?? `${p.path}${p.manufacturer ? ` — ${p.manufacturer}` : ''}`,
        }
      })
    } catch (e) {
      this.log('error', `Serial list failed: ${(e as Error).message}`)
      return []
    }
  }

  async connect(portPath: string, baud = 115200): Promise<{ ok: boolean; mock: boolean; message: string }> {
    await this.disconnect()
    this.portPath = portPath
    this.baud = baud
    this.rxTotal = 0
    if (portPath === '__mock__') {
      this.mock = true
      this.firmware = `PN532 v${MOCK_FIRMWARE.ver}.${MOCK_FIRMWARE.rev} (mock)`
      this.log('info', 'Connected to mock PN532 (no hardware)')
      return { ok: true, mock: true, message: 'Connected (mock device)' }
    }
    this.mock = false
    this.port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false })
    this.rxBuf = []
    await new Promise<void>((resolve, reject) => {
      this.port!.open((err) => (err ? reject(err) : resolve()))
    })
    this.port.on('data', (chunk: Buffer) => this.onData([...chunk]))
    this.port.on('error', (err) => this.log('error', `Serial error: ${err.message}`))
    this.log('info', `Opened ${portPath} @ ${baud} baud`)
    try {
      const fw = await this.handshake(baud)
      this.firmware = fw.label
      await this.samConfiguration()
      return { ok: true, mock: false, message: `Connected — ${fw.label}` }
    } catch (e) {
      const msg = (e as Error).message
      this.log('error', `PN532 handshake failed: ${msg}`)
      await this.disconnect().catch(() => undefined)
      if (this.rxTotal === 0) {
        throw new Error(
          `PN532 is silent — 0 bytes came back on ${portPath}. Most likely: (1) wrong COM port selected (in Device Manager, unplug the USB-TTL adapter and see which COM disappears — don't pick modem/Bluetooth ports like Intel AMT SOL); (2) module not in HSU mode — set BOTH DIP switches OFF, then POWER-CYCLE the module (mode is latched at power-up); (3) wiring — adapter TX → module RX, adapter RX → module TX, GND → GND (must be crossed + common ground); (4) module not powered — feed VCC 5V (or 3.3V) from the adapter. Last error: ${msg}`,
        )
      }
      throw new Error(
        `PN532 sent ${this.rxTotal} byte(s) but no valid HSU frame @ ${this.baud} baud (tried 115200/57600). Likely baud mismatch or the module is in I2C/SPI mode — set BOTH DIP switches OFF for HSU and power-cycle. Last error: ${msg}`,
      )
    }
  }

  /** HSU wake-up pulse (libnfc sequence): 0x55 0x55 + zeros, then settle.
   *  Harmless when already awake — the PN532 ignores non-preamble bytes. */
  private async wakeup(): Promise<void> {
    await this.writeRaw([0x55, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    await sleep(150)
    await new Promise<void>((resolve) => this.port!.flush(() => resolve()))
    this.rxBuf = []
  }

  private async writeRaw(bytes: number[]): Promise<void> {
    if (!this.port?.isOpen) throw new Error('Not connected')
    await new Promise<void>((resolve, reject) => {
      this.port!.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()))
    })
    await new Promise<void>((resolve) => this.port!.drain(() => resolve()))
  }

  private async setBaud(baud: number): Promise<void> {
    if (!this.port) throw new Error('Not connected')
    await new Promise<void>((resolve, reject) => {
      this.port!.update({ baudRate: baud }, (err) => (err ? reject(err) : resolve()))
    })
    this.baud = baud
  }

  /** Wake-up + GetFirmwareVersion with retries and 115200/57600 fallback. */
  private async handshake(preferredBaud: number): Promise<{ label: string }> {
    const candidates = preferredBaud === 115200 ? [115200, 57600] : [preferredBaud, 115200]
    let lastErr: Error = new Error('handshake never attempted')
    for (const b of candidates) {
      if (b !== this.baud) {
        this.log('info', `Trying ${b} baud…`)
        await this.setBaud(b)
      }
      await this.wakeup()
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await this.getFirmwareVersion(1500)
        } catch (e) {
          lastErr = e as Error
          this.log('info', `Handshake attempt ${attempt}/3 @ ${b} baud: ${lastErr.message}`)
          this.rxBuf = []
          await sleep(200)
        }
      }
    }
    throw lastErr
  }

  async disconnect(): Promise<{ ok: boolean }> {
    this.stopPolling()
    this.waiters.splice(0).forEach((w) => {
      clearTimeout(w.timer)
      w.reject(new Error('Disconnected'))
    })
    if (this.port?.isOpen) {
      await new Promise<void>((resolve) => this.port!.close(() => resolve()))
    }
    this.port = null
    this.portPath = null
    this.mock = false
    this.rxBuf = []
    return { ok: true }
  }

  status(): StatusInfo {
    return {
      connected: this.mock || (this.port?.isOpen ?? false),
      mock: this.mock,
      port: this.mock ? '__mock__' : this.portPath,
      baud: this.baud,
      firmware: this.firmware,
      lastTarget: this.lastTarget,
    }
  }

  private onData(bytes: number[]) {
    this.rxTotal += bytes.length
    this.rxBuf.push(...bytes)
    for (;;) {
      let decoded: { frame: DecodedFrame; consumed: number } | null = null
      try {
        decoded = tryDecodeOne(this.rxBuf)
      } catch (e) {
        this.log('error', `Frame decode error: ${(e as Error).message}`)
        this.rxBuf = []
        break
      }
      if (!decoded) break
      this.rxBuf = this.rxBuf.slice(decoded.consumed)
      const { frame } = decoded
      if (frame.kind === 'ack') {
        this.log('rx', 'ACK', ACK_FRAME.map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase())
        continue
      }
      if (frame.kind === 'nack') {
        this.log('error', 'NACK from PN532')
        continue
      }
      const hex = frame.raw.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
      this.log('rx', `RSP 0x${(frame.command ?? 0).toString(16).padStart(2, '0')}`, hex)
      // resolve first waiter matching command (or any response after ACK)
      const idx = this.waiters.findIndex((w) => w.wantCmd === undefined || w.wantCmd === (frame.command !== undefined ? frame.command - 1 : undefined) || w.wantCmd === frame.command)
      const waiter = idx >= 0 ? this.waiters.splice(idx, 1)[0]! : undefined
      waiter?.resolve(frame)
    }
  }

  private async transact(cmd: number, params: number[] = [], timeoutMs = 2000): Promise<number[]> {
    if (this.mock) return this.mockTransact(cmd, params)
    if (!this.port?.isOpen) throw new Error('Not connected')
    const frame = encodeCommand(cmd, params)
    const hex = [...frame].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    this.log('tx', `CMD 0x${cmd.toString(16).padStart(2, '0')}`, hex)
    const wantRsp = (cmd + 1) & 0xff
    const promise = new Promise<DecodedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error(`Timeout waiting for response 0x${wantRsp.toString(16)} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.waiters.push({ resolve, reject, timer, wantCmd: wantRsp })
    })
    await new Promise<void>((resolve, reject) => {
      this.port!.write(frame, (err) => (err ? reject(err) : resolve()))
    })
    const rsp = await promise
    if (rsp.kind === 'error') throw new Error('PN532 error frame (application error)')
    if (rsp.command !== wantRsp) throw new Error(`Unexpected response 0x${rsp.command?.toString(16)} (wanted 0x${wantRsp.toString(16)})`)
    return rsp.data
  }

  // ---- high-level ops ----
  async getFirmwareVersion(timeoutMs = 2000) {
    const data = await this.transact(CMD.GetFirmwareVersion, [], timeoutMs)
    const info = parseFirmwareVersion(data)
    this.firmware = info.label
    return { ...info }
  }

  async samConfiguration() {
    const data = await this.transact(CMD.SAMConfiguration, samConfigParams(), 2000)
    if (data.length > 0 && data[0] !== 0x00 && data[0] !== undefined) {
      // SAMConfiguration response is empty on success in most firmware; tolerate
    }
    this.log('info', 'SAM configured (normal mode)')
    return { ok: true as const }
  }

  async pollOnce(timeoutMs = 1500): Promise<TargetInfo> {
    if (this.mock) {
      const t: TargetInfo = {
        found: true,
        uid: '04 A3 B2 C1',
        sak: '08',
        ats: '',
        type: 'MIFARE Classic 1K (mock)',
        at: new Date().toISOString(),
        raw: 'D5 4B 01 01 00 04 04 A3 B2 C1 20 08',
      }
      this.lastTarget = t
      return t
    }
    // Reduce retries so poll returns fast when no card
    await this.transact(CMD.RFConfiguration, [0x05, 0xff, 0x01, 0x01], 1000).catch(() => [])
    const data = await this.transact(CMD.InListPassiveTarget, inListPassiveTargetParams(), timeoutMs + 800)
    // data: [NbTg, Tg, BrRx, BrTx, Type, ...]
    if (data.length === 0 || data[0] === 0x00) {
      return { found: false, at: new Date().toISOString() }
    }
    const uidLenIdx = 5
    const uidLen = data[uidLenIdx] ?? 0
    const uid = data.slice(uidLenIdx + 1, uidLenIdx + 1 + uidLen)
    const sak = data[uidLenIdx + 1 + uidLen]
    const atsLen = data[uidLenIdx + 2 + uidLen] ?? 0
    const ats = data.slice(uidLenIdx + 3 + uidLen, uidLenIdx + 3 + uidLen + atsLen)
    const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    const info: TargetInfo = {
      found: true,
      at: new Date().toISOString(),
      uid: hex(uid),
      sak: sak !== undefined ? sak.toString(16).padStart(2, '0').toUpperCase() : undefined,
      ats: ats.length ? hex(ats) : '',
      type: guessType(sak, uid.length),
      raw: hex(data),
    }
    this.lastTarget = info
    return info
  }

  startPolling(intervalMs: number, onTarget: (t: TargetInfo) => void) {
    this.stopPolling()
    let busy = false
    this.pollTimer = setInterval(() => {
      if (busy) return
      busy = true
      this.pollOnce(Math.min(intervalMs, 1500))
        .then((t) => {
          if (t.found) onTarget(t)
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false
        })
    }, intervalMs)
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async mifareReadBlock(block: number, keyHex: string, keyType: 'A' | 'B'): Promise<{ hex: string; bytes: number[] }> {
    const key = parseKey(keyHex)
    if (!this.lastTarget?.uid) throw new Error('Poll for a target first (UID required for auth)')
    const uid = this.lastTarget.uid.split(' ').map((h) => parseInt(h, 16))
    if (this.mock) {
      const bytes = Array.from({ length: 16 }, (_, i) => (block * 16 + i) & 0xff)
      return { hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '), bytes }
    }
    const auth = await this.transact(CMD.InDataExchange, mifareAuthParams(block, key, uid, keyType === 'A'), 2000)
    if (auth[0] !== 0x00) throw new Error(`MIFARE auth failed (err 0x${auth[0]?.toString(16)}) — wrong key or block?`)
    const read = await this.transact(CMD.InDataExchange, [0x01, 0x30, block], 2000)
    if (read[0] !== 0x00) throw new Error(`MIFARE read failed (err 0x${read[0]?.toString(16)})`)
    const bytes = read.slice(1, 17)
    return { hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '), bytes }
  }

  async mifareWriteBlock(block: number, keyHex: string, keyType: 'A' | 'B', dataHex: string): Promise<{ ok: boolean }> {
    const key = parseKey(keyHex)
    const data = parseData(dataHex, 16)
    if (!this.lastTarget?.uid) throw new Error('Poll for a target first (UID required for auth)')
    const uid = this.lastTarget.uid.split(' ').map((h) => parseInt(h, 16))
    if (this.mock) return { ok: true }
    if (isTrailerBlock(block)) throw new Error(`Refusing to write sector trailer block ${block} (keys/access bits live there)`)
    const auth = await this.transact(CMD.InDataExchange, mifareAuthParams(block, key, uid, keyType === 'A'), 2000)
    if (auth[0] !== 0x00) throw new Error(`MIFARE auth failed (err 0x${auth[0]?.toString(16)})`)
    const wr = await this.transact(CMD.InDataExchange, [0x01, 0xa0, block, ...data], 2000)
    if (wr[0] !== 0x00) throw new Error(`MIFARE write failed (err 0x${wr[0]?.toString(16)})`)
    return { ok: true }
  }

  async ntagReadPage(page: number): Promise<{ hex: string; bytes: number[] }> {
    if (this.mock) {
      const bytes = [0x04, 0xa3, 0xb2, 0xc1]
      return { hex: '04 A3 B2 C1', bytes }
    }
    const rsp = await this.transact(CMD.InDataExchange, [0x01, 0x30, page], 2000)
    if (rsp[0] !== 0x00) throw new Error(`NTAG read failed (err 0x${rsp[0]?.toString(16)})`)
    const bytes = rsp.slice(1, 17)
    return { hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '), bytes }
  }

  async ntagWritePage(page: number, dataHex: string): Promise<{ ok: boolean }> {
    const data = parseData(dataHex, 4)
    if (this.mock) return { ok: true }
    if (page < 4) throw new Error('Refusing to write NTAG lock/manufacturer pages 0–3')
    const rsp = await this.transact(CMD.InDataExchange, [0x01, 0xa2, page, ...data], 2000)
    if (rsp[0] !== 0x00) throw new Error(`NTAG write failed (err 0x${rsp[0]?.toString(16)})`)
    return { ok: true }
  }

  async rawCommand(commandHex: string, timeoutMs = 2000): Promise<{ tx: string; rx: string; data: number[] }> {
    const bytes = commandHex
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((h) => {
        const v = parseInt(h, 16)
        if (Number.isNaN(v) || v < 0 || v > 255) throw new Error(`Bad hex byte: ${h}`)
        return v
      })
    if (bytes.length === 0) throw new Error('Empty command')
    const [cmd, ...params] = bytes as [number, ...number[]]
    const data = await this.transact(cmd, params, timeoutMs)
    return {
      tx: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      rx: data.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      data,
    }
  }

  private mockTransact(cmd: number, _params: number[]): Promise<number[]> {
    const rsp = (cmd + 1) & 0xff
    void rsp
    if (cmd === CMD.GetFirmwareVersion) return Promise.resolve([MOCK_FIRMWARE.ic, MOCK_FIRMWARE.ver, MOCK_FIRMWARE.rev, MOCK_FIRMWARE.support])
    if (cmd === CMD.SAMConfiguration) return Promise.resolve([])
    if (cmd === CMD.InListPassiveTarget) return Promise.resolve([0x01, 0x01, 0x00, 0x01, 0x00, 0x04, 0x04, 0xa3, 0xb2, 0xc1, 0x20, 0x08])
    if (cmd === CMD.InDataExchange) return Promise.resolve([0x00, ...Array.from({ length: 16 }, (_, i) => i)])
    return Promise.resolve([0x00])
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseKey(keyHex: string): number[] {  const clean = keyHex.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length !== 12) throw new Error('Key must be 6 bytes (12 hex chars), e.g. FFFFFFFFFFFF')
  const out: number[] = []
  for (let i = 0; i < 12; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
  return out
}

function parseData(dataHex: string, expected: number): number[] {
  const clean = dataHex.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length !== expected * 2) throw new Error(`Data must be ${expected} bytes (${expected * 2} hex chars)`)
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
  return out
}

function isTrailerBlock(block: number): boolean {
  // MIFARE Classic 1K: every 4th block (3,7,11,...) is a sector trailer
  return block % 4 === 3
}

function guessType(sak?: number, uidLen = 4): string {
  if (sak === 0x08) return 'MIFARE Classic 1K'
  if (sak === 0x18) return 'MIFARE Classic 4K'
  if (sak === 0x00 && uidLen === 7) return 'NTAG / Ultralight'
  if (sak === undefined) return 'Unknown'
  return `ISO14443A (SAK 0x${sak.toString(16).padStart(2, '0').toUpperCase()})`
}
