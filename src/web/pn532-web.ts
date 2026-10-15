/**
 * Browser transport for the Vercel demo: implements the same surface as the
 * Electron preload api, backed by Web Serial (Chrome/Edge) or an offline mock.
 * All PN532 framing/command/NDEF logic is shared with the desktop app.
 */
import { encodeCommand, tryDecodeOne, ACK_FRAME, type DecodedFrame } from '@shared/pn532/frame'
import {
  CMD,
  samConfigParams,
  inListPassiveTargetParams,
  mifareAuthParams,
} from '@shared/pn532/commands'
import { decodeNdefMessage, extractNdefTlv, parseCapabilityContainer } from '@shared/pn532/ndef'

export interface WebPortInfo {
  path: string
  manufacturer?: string
  friendly?: string
}

export interface WebTarget {
  found: boolean
  at?: string
  uid?: string
  sak?: string
  ats?: string
  type?: string
  raw?: string
}

export interface WebLog {
  id: number
  ts: string
  dir: 'tx' | 'rx' | 'info' | 'error'
  label: string
  hex?: string
}

const MOCK_FIRMWARE = { ic: 0x32, ver: 1, rev: 6, support: 7 }
const MOCK_PORT = '__mock__'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')

function hasSerial(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

class WebPn532 {
  private port: SerialPort | null = null
  private portId: string | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private reading = false
  private granted: SerialPort[] = []
  private baud = 115200
  private rxBuf: number[] = []
  private rxTotal = 0
  private txTotal = 0
  private firstRx: number[] = []
  private waiters: Array<{
    resolve: (f: DecodedFrame) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
    wantCmd?: number
  }> = []
  private logSeq = 0
  private logListeners = new Set<(e: WebLog) => void>()
  private targetListeners = new Set<(t: WebTarget) => void>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private firmware: string | null = null
  private lastTarget: WebTarget | null = null
  private mock = false

  onLog(cb: (e: WebLog) => void) {
    this.logListeners.add(cb)
    return () => {
      this.logListeners.delete(cb)
    }
  }

  onTarget(cb: (t: WebTarget) => void) {
    this.targetListeners.add(cb)
    return () => {
      this.targetListeners.delete(cb)
    }
  }

  private log(dir: WebLog['dir'], label: string, hexStr?: string) {
    const entry: WebLog = { id: ++this.logSeq, ts: new Date().toISOString(), dir, label, hex: hexStr }
    this.logListeners.forEach((cb) => cb(entry))
  }

  private emitTarget(t: WebTarget) {
    this.targetListeners.forEach((cb) => cb(t))
  }

  async listPorts(): Promise<WebPortInfo[]> {
    const mock = { path: MOCK_PORT, friendly: 'Mock device (no hardware)' }
    if (!hasSerial()) return [mock]
    try {
      this.granted = await navigator.serial.getPorts()
    } catch {
      this.granted = []
    }
    return [
      mock,
      ...this.granted.map((p, i) => {
        let tag = `USB device ${i + 1}`
        try {
          const info = p.getInfo()
          tag = `USB ${info.usbVendorId?.toString(16).padStart(4, '0') ?? '????'}:${info.usbProductId?.toString(16).padStart(4, '0') ?? '????'}`
        } catch {
          /* ignore */
        }
        return { path: `web:${i}`, friendly: `${tag} — previously allowed` }
      }),
    ]
  }

  /** Opens the browser's port picker (must run in a click handler), then returns the updated list. */
  async pickPort(): Promise<WebPortInfo[]> {
    if (!hasSerial()) throw new Error('This browser cannot access USB hardware — use Chrome or Edge, or explore with the Mock device.')
    await navigator.serial.requestPort()
    const list = await this.listPorts()
    return list
  }

  private portFor(id: string): SerialPort {
    const m = /^web:(\d+)$/.exec(id)
    const p = m ? this.granted[Number(m[1])] : undefined
    if (!p) throw new Error('Port not found — click “New device…” and allow it again.')
    return p
  }

  private serialOpts(baud: number): SerialOptions {
    return { baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 255 }
  }

  private async attach() {
    if (!this.port) throw new Error('Not connected')
    this.writer = this.port.writable!.getWriter()
    this.reader = this.port.readable!.getReader()
    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true })
    } catch {
      /* not all adapters support signals */
    }
    this.reading = true
    void this.readLoop()
  }

  private async detach() {
    this.reading = false
    try {
      await this.reader?.cancel()
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock()
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock()
    } catch {
      /* ignore */
    }
    this.reader = null
    this.writer = null
  }

  private async readLoop() {
    while (this.reading && this.reader) {
      try {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value && value.length) this.onData([...value])
      } catch {
        break
      }
    }
  }

  async connect(portId: string, baud = 115200): Promise<{ ok: boolean; mock: boolean; message: string }> {
    await this.disconnect()
    this.portId = portId
    this.baud = baud
    this.rxTotal = 0
    this.txTotal = 0
    this.firstRx = []
    if (portId === MOCK_PORT) {
      this.mock = true
      this.firmware = `PN532 v${MOCK_FIRMWARE.ver}.${MOCK_FIRMWARE.rev} (mock)`
      this.log('info', 'Connected to mock PN532 (no hardware)')
      return { ok: true, mock: true, message: 'Connected (mock device)' }
    }
    if (!hasSerial()) throw new Error('This browser cannot access USB hardware — use Chrome or Edge.')
    this.mock = false
    this.port = this.portFor(portId)
    try {
      await this.port.open(this.serialOpts(baud))
    } catch (e) {
      const msg = (e as Error).message
      this.port = null
      if (/exclusiv|in use|busy|access/i.test(msg)) {
        throw new Error(`Could not open the device: another tab or program is using it. Close it there and retry. (Detail: ${msg})`)
      }
      throw new Error(`Could not open the device: ${msg}`)
    }
    await this.attach()
    await sleep(300)
    this.log('info', `Opened device @ ${baud} baud`)
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
          `PN532 is silent — 0 bytes came back. Check the reader is in HSU/UART mode (both switches OFF + unplug/replug), the cable carries data, and the tag side is powered. Last error: ${msg}`,
        )
      }
      throw new Error(`PN532 sent ${this.rxTotal} byte(s) but no valid frame. First bytes: ${hex(this.firstRx) || '—'}. Last error: ${msg}`)
    }
  }

  async disconnect(): Promise<{ ok: boolean }> {
    this.stopPolling()
    this.waiters.splice(0).forEach((w) => {
      clearTimeout(w.timer)
      w.reject(new Error('Disconnected'))
    })
    await this.detach()
    if (this.port) {
      try {
        await this.port.close()
      } catch {
        /* ignore */
      }
    }
    this.port = null
    this.portId = null
    this.mock = false
    this.rxBuf = []
    return { ok: true }
  }

  status() {
    return {
      connected: this.mock || this.port !== null,
      mock: this.mock,
      port: this.mock ? MOCK_PORT : this.portId,
      baud: this.baud,
      firmware: this.firmware,
      lastTarget: this.lastTarget,
      rxTotal: this.rxTotal,
      txTotal: this.txTotal,
    }
  }

  private async writeRaw(bytes: number[]): Promise<void> {
    if (!this.writer) throw new Error('Not connected')
    await this.writer.write(new Uint8Array(bytes))
    this.txTotal += bytes.length
  }

  private async wakeup(): Promise<void> {
    await this.writeRaw([0x55, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    await sleep(250)
    this.rxBuf = []
  }

  private async setBaud(baud: number): Promise<void> {
    if (!this.port) throw new Error('Not connected')
    await this.detach()
    try {
      await this.port.close()
    } catch {
      /* ignore */
    }
    await this.port.open(this.serialOpts(baud))
    await this.attach()
    this.baud = baud
  }

  private async handshake(preferredBaud: number): Promise<{ label: string }> {
    const sweep = [115200, 57600, 38400, 19200, 9600]
    const candidates = [preferredBaud, ...sweep.filter((b) => b !== preferredBaud)]
    let lastErr: Error = new Error('handshake never attempted')
    for (const b of candidates) {
      if (b !== this.baud) {
        this.log('info', `Trying ${b} baud…`)
        await this.setBaud(b)
      }
      await this.wakeup()
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await this.getFirmwareVersion(1500)
        } catch (e) {
          lastErr = e as Error
          this.log('info', `Handshake attempt ${attempt}/2 @ ${b} baud: ${lastErr.message}`)
          this.rxBuf = []
          await sleep(200)
        }
      }
    }
    throw lastErr
  }

  private onData(bytes: number[]) {
    this.rxTotal += bytes.length
    if (this.firstRx.length < 32) this.firstRx.push(...bytes.slice(0, 32 - this.firstRx.length))
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
        this.log('rx', 'ACK', hex(ACK_FRAME))
        continue
      }
      if (frame.kind === 'nack') {
        this.log('error', 'NACK from PN532')
        continue
      }
      this.log('rx', `RSP 0x${(frame.command ?? 0).toString(16).padStart(2, '0')}`, hex(frame.raw))
      const idx = this.waiters.findIndex((w) => w.wantCmd === undefined || w.wantCmd === frame.command)
      const waiter = idx >= 0 ? this.waiters.splice(idx, 1)[0]! : undefined
      waiter?.resolve(frame)
    }
  }

  private async transact(cmd: number, params: number[] = [], timeoutMs = 2000): Promise<number[]> {
    if (this.mock) return this.mockTransact(cmd)
    if (!this.writer) throw new Error('Not connected')
    const frame = encodeCommand(cmd, params)
    this.log('tx', `CMD 0x${cmd.toString(16).padStart(2, '0')}`, hex([...frame]))
    const wantRsp = (cmd + 1) & 0xff
    const promise = new Promise<DecodedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error(`Timeout waiting for response 0x${wantRsp.toString(16)} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.waiters.push({ resolve, reject, timer, wantCmd: wantRsp })
    })
    await this.writer.write(frame)
    this.txTotal += frame.length
    const rsp = await promise
    if (rsp.kind === 'error') throw new Error('PN532 error frame (application error)')
    if (rsp.command !== wantRsp) throw new Error(`Unexpected response 0x${rsp.command?.toString(16)}`)
    return rsp.data
  }

  async getFirmwareVersion(timeoutMs = 2000) {
    const data = await this.transact(CMD.GetFirmwareVersion, [], timeoutMs)
    if (data.length < 4) throw new Error(`Short firmware response: ${data.length} bytes`)
    const [ic, ver, rev, support] = data as [number, number, number, number]
    const info = { ic, ver, rev, support, raw: [...data], label: `PN5${ic.toString(16).toUpperCase()} v${ver}.${rev}` }
    this.firmware = info.label
    return { ...info }
  }

  async samConfiguration() {
    await this.transact(CMD.SAMConfiguration, samConfigParams(), 2000)
    this.log('info', 'SAM configured (normal mode)')
    return { ok: true as const }
  }

  async pollOnce(timeoutMs = 1500): Promise<WebTarget> {
    if (this.mock) {
      const t: WebTarget = {
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
    await this.transact(CMD.RFConfiguration, [0x05, 0xff, 0x01, 0x01], 1000).catch(() => [])
    const data = await this.transact(CMD.InListPassiveTarget, inListPassiveTargetParams(), timeoutMs + 800)
    if (data.length === 0 || data[0] === 0x00) return { found: false, at: new Date().toISOString() }
    const uidLen = data[5] ?? 0
    const uid = data.slice(6, 6 + uidLen)
    const sak = data[6 + uidLen]
    const atsLen = data[7 + uidLen] ?? 0
    const ats = data.slice(8 + uidLen, 8 + uidLen + atsLen)
    const info: WebTarget = {
      found: true,
      at: new Date().toISOString(),
      uid: hex(uid),
      sak: sak !== undefined ? sak.toString(16).padStart(2, '0').toUpperCase() : undefined,
      ats: ats.length ? hex(ats) : '',
      type: sak === 0x08 ? 'MIFARE Classic 1K' : sak === 0x18 ? 'MIFARE Classic 4K' : sak === 0x00 && uidLen === 7 ? 'NTAG / Ultralight' : `ISO14443A (SAK 0x${(sak ?? 0).toString(16).padStart(2, '0').toUpperCase()})`,
      raw: hex(data),
    }
    this.lastTarget = info
    return info
  }

  startPolling(intervalMs: number, onTarget: (t: WebTarget) => void) {
    this.stopPolling()
    let busy = false
    this.pollTimer = setInterval(() => {
      if (busy) return
      busy = true
      this.pollOnce(Math.min(intervalMs, 1500))
        .then((t) => {
          if (t.found) {
            onTarget(t)
            this.emitTarget(t)
          }
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

  async echoTest(portId: string, baud = 115200) {
    if (portId === MOCK_PORT) {
      return { ok: true, sent: '48 45 4C 4C 4F 31 32 33', received: '48 45 4C 4C 4F 31 32 33', message: 'Mock loopback PASS (simulated).' }
    }
    if (!hasSerial()) throw new Error('This browser cannot access USB hardware — use Chrome or Edge.')
    const port = this.portFor(portId)
    const pattern = [0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x31, 0x32, 0x33]
    await port.open(this.serialOpts(baud))
    try {
      const received: number[] = []
      const reader = port.readable!.getReader()
      const writer = port.writable!.getWriter()
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) received.push(...value)
        }
      })()
      await writer.write(new Uint8Array(pattern))
      await sleep(800)
      reader.releaseLock()
      writer.releaseLock()
      await pump.catch(() => undefined)
      const ok = received.length >= pattern.length && pattern.every((b, i) => received[i] === b)
      return {
        ok,
        sent: hex(pattern),
        received: hex(received),
        message: ok
          ? 'Loopback PASS — adapter + driver + port are fine. Any silence is on the reader side.'
          : `Loopback FAIL — TX joined to RX did not echo (RX: ${hex(received) || 'nothing'}). Check the wire, cable, and driver.`,
      }
    } finally {
      try {
        await port.close()
      } catch {
        /* ignore */
      }
    }
  }

  private parseKey(keyHex: string): number[] {
    const clean = keyHex.replace(/[^0-9a-fA-F]/g, '')
    if (clean.length !== 12) throw new Error('Key must be 6 bytes (12 hex chars), e.g. FFFFFFFFFFFF')
    const out: number[] = []
    for (let i = 0; i < 12; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
    return out
  }

  private parseData(dataHex: string, expected: number): number[] {
    const clean = dataHex.replace(/[^0-9a-fA-F]/g, '')
    if (clean.length !== expected * 2) throw new Error(`Data must be ${expected} bytes (${expected * 2} hex chars)`)
    const out: number[] = []
    for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
    return out
  }

  async mifareReadBlock(block: number, keyHex: string, keyType: 'A' | 'B') {
    const key = this.parseKey(keyHex)
    if (!this.lastTarget?.uid) throw new Error('Scan for a card first (UID is needed for auth)')
    const uid = this.lastTarget.uid.split(' ').map((h) => parseInt(h, 16))
    if (this.mock) {
      const bytes = Array.from({ length: 16 }, (_, i) => (block * 16 + i) & 0xff)
      return { hex: hex(bytes), bytes }
    }
    const auth = await this.transact(CMD.InDataExchange, mifareAuthParams(block, key, uid, keyType === 'A'), 2000)
    if (auth[0] !== 0x00) throw new Error(`Card rejected the key (err 0x${auth[0]?.toString(16)}) — wrong key or block?`)
    const read = await this.transact(CMD.InDataExchange, [0x01, 0x30, block], 2000)
    if (read[0] !== 0x00) throw new Error(`Read failed (err 0x${read[0]?.toString(16)})`)
    const bytes = read.slice(1, 17)
    return { hex: hex(bytes), bytes }
  }

  async mifareWriteBlock(block: number, keyHex: string, keyType: 'A' | 'B', dataHex: string) {
    const key = this.parseKey(keyHex)
    const data = this.parseData(dataHex, 16)
    if (!this.lastTarget?.uid) throw new Error('Scan for a card first (UID is needed for auth)')
    const uid = this.lastTarget.uid.split(' ').map((h) => parseInt(h, 16))
    if (this.mock) return { ok: true }
    if (block % 4 === 3) throw new Error(`Refusing to write protected block ${block}`)
    const auth = await this.transact(CMD.InDataExchange, mifareAuthParams(block, key, uid, keyType === 'A'), 2000)
    if (auth[0] !== 0x00) throw new Error(`Card rejected the key (err 0x${auth[0]?.toString(16)})`)
    const wr = await this.transact(CMD.InDataExchange, [0x01, 0xa0, block, ...data], 2000)
    if (wr[0] !== 0x00) throw new Error(`Write failed (err 0x${wr[0]?.toString(16)})`)
    return { ok: true }
  }

  async ntagReadPage(page: number) {
    if (this.mock) return { hex: '04 A3 B2 C1', bytes: [0x04, 0xa3, 0xb2, 0xc1] }
    const rsp = await this.transact(CMD.InDataExchange, [0x01, 0x30, page], 2000)
    if (rsp[0] !== 0x00) throw new Error(`Read failed (err 0x${rsp[0]?.toString(16)})`)
    const bytes = rsp.slice(1, 17)
    return { hex: hex(bytes), bytes }
  }

  async ntagWritePage(page: number, dataHex: string) {
    const data = this.parseData(dataHex, 4)
    if (this.mock) return { ok: true }
    if (page < 4) throw new Error('The first pages are protected and cannot be written')
    const rsp = await this.transact(CMD.InDataExchange, [0x01, 0xa2, page, ...data], 2000)
    if (rsp[0] !== 0x00) throw new Error(`Write failed (err 0x${rsp[0]?.toString(16)})`)
    return { ok: true }
  }

  async ndefWriteTag(tlv: number[]) {
    if (tlv.length === 0 || tlv.length % 4 !== 0) throw new Error('Message must be a non-empty multiple of 4 bytes')
    if (tlv.length > 888) throw new Error('Message exceeds the largest tag (888 bytes)')
    if (this.mock) return { pages: tlv.length / 4, bytes: tlv.length, capacity: 144, verify: '(mock — write assumed OK)' }
    const ccRsp = await this.transact(CMD.InDataExchange, [0x01, 0x30, 0x03], 2000)
    if (ccRsp[0] !== 0x00) throw new Error('Could not read the tag — is a card in the field?')
    const cc = parseCapabilityContainer(ccRsp.slice(1, 5))
    if (!cc.magic) throw new Error('Tag is not formatted for messages. Use an NDEF tag.')
    if (!cc.readWrite) throw new Error('Tag reports read-only access.')
    if (tlv.length > cc.sizeBytes) {
      throw new Error(`Message needs ${tlv.length} bytes but this tag holds ${cc.sizeBytes}. Shorten it or use a bigger tag.`)
    }
    const pages = tlv.length / 4
    for (let p = 0; p < pages; p++) {
      const rsp = await this.transact(CMD.InDataExchange, [0x01, 0xa2, 0x04 + p, ...tlv.slice(p * 4, p * 4 + 4)], 2000)
      if (rsp[0] !== 0x00) throw new Error(`Write failed at page ${0x04 + p}`)
    }
    const dump: number[] = []
    for (let pg = 4; pg < 4 + pages; pg += 4) {
      const rsp = await this.transact(CMD.InDataExchange, [0x01, 0x30, pg], 2000)
      if (rsp[0] !== 0x00) throw new Error(`Verify read failed at page ${pg}`)
      dump.push(...rsp.slice(1, 17))
    }
    const msgBytes = extractNdefTlv(dump.slice(0, tlv.length))
    const recs = msgBytes ? decodeNdefMessage(msgBytes) : []
    const verify = recs.length ? recs.map((r) => r.text ?? r.uri ?? r.type).join(' | ') : 'written, but nothing decoded on read-back — scan the tag again'
    return { pages, bytes: tlv.length, capacity: cc.sizeBytes, verify }
  }

  async rawCommand(commandHex: string, timeoutMs = 2000) {
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
    return { tx: hex(bytes), rx: hex(data), data }
  }

  private mockTransact(cmd: number): Promise<number[]> {
    if (cmd === CMD.GetFirmwareVersion) return Promise.resolve([MOCK_FIRMWARE.ic, MOCK_FIRMWARE.ver, MOCK_FIRMWARE.rev, MOCK_FIRMWARE.support])
    if (cmd === CMD.SAMConfiguration) return Promise.resolve([])
    if (cmd === CMD.InListPassiveTarget) return Promise.resolve([0x01, 0x01, 0x00, 0x01, 0x00, 0x04, 0x04, 0xa3, 0xb2, 0xc1, 0x20, 0x08])
    if (cmd === CMD.InDataExchange) return Promise.resolve([0x00, ...Array.from({ length: 16 }, (_, i) => i)])
    return Promise.resolve([0x00])
  }

  openUrl(url: string) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Not a valid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only web links can be opened')
    }
    window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
    return { ok: true as const }
  }
}

export function installWebApi() {
  const svc = new WebPn532()
  ;(window as unknown as Record<string, unknown>).pn532 = {
    listPorts: () => svc.listPorts(),
    pickPort: () => svc.pickPort(),
    webSerial: () => hasSerial(),
    echoTest: (port: string, baud = 115200) => svc.echoTest(port, baud),
    connect: (port: string, baud = 115200) => svc.connect(port, baud),
    disconnect: () => svc.disconnect(),
    status: () => svc.status(),
    firmware: () => svc.getFirmwareVersion(),
    samConfig: () => svc.samConfiguration(),
    pollOnce: (timeoutMs = 1500) => svc.pollOnce(timeoutMs),
    pollStart: (intervalMs = 1200) => {
      svc.startPolling(intervalMs, () => undefined)
      return { ok: true }
    },
    pollStop: () => svc.stopPolling(),
    mifareRead: (args: { block: number; key: string; keyType: 'A' | 'B' }) => svc.mifareReadBlock(args.block, args.key, args.keyType),
    mifareWrite: (args: { block: number; key: string; keyType: 'A' | 'B'; dataHex: string }) =>
      svc.mifareWriteBlock(args.block, args.key, args.keyType, args.dataHex),
    ntagRead: (page: number) => svc.ntagReadPage(page),
    ntagWrite: (page: number, dataHex: string) => svc.ntagWritePage(page, dataHex),
    ndefWrite: (bytes: number[]) => svc.ndefWriteTag(bytes),
    raw: (commandHex: string, timeoutMs = 2000) => svc.rawCommand(commandHex, timeoutMs),
    onTarget: (cb: (t: WebTarget) => void) => svc.onTarget(cb),
    onLog: (cb: (e: WebLog) => void) => svc.onLog(cb),
    openUrl: (url: string) => svc.openUrl(url),
  }
}
