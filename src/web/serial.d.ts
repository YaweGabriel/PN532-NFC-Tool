/** Minimal Web Serial API declarations (only what pn532-web.ts uses). */
interface SerialOptions {
  baudRate: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd'
  bufferSize?: number
  flowControl?: 'none' | 'hardware'
}

interface SerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

interface SerialOutputSignals {
  dataTerminalReady?: boolean
  requestToSend?: boolean
  break?: boolean
}

interface SerialPort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  open(options: SerialOptions): Promise<void>
  close(): Promise<void>
  getInfo(): SerialPortInfo
  setSignals(signals: SerialOutputSignals): Promise<void>
}

interface Serial extends EventTarget {
  getPorts(): Promise<SerialPort[]>
  requestPort(): Promise<SerialPort>
}

interface Navigator {
  serial: Serial
}
