/** Minimal NDEF decode (well-known Text + URI) for NTAG/Ultralight page reads. */
export interface NdefRecord {
  tnf: number
  type: string
  id: string
  payload: number[]
  text?: string
  uri?: string
}

const URI_PREFIXES = [
  "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
  "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://",
  "nfs://", "ftp://", "dav://", "news:", "telnet://", "imap:", "rtsp://", "urn:",
  "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://", "btgoep://",
  "tcpobex://", "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:",
  "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:",
]

export function decodeNdefMessage(bytes: number[]): NdefRecord[] {
  const records: NdefRecord[] = []
  let i = 0
  while (i < bytes.length) {
    if (i + 2 > bytes.length) break
    const flags = bytes[i++]
    const mb = (flags & 0x80) !== 0
    void mb
    const me = (flags & 0x40) !== 0
    const sr = (flags & 0x10) !== 0
    const il = (flags & 0x08) !== 0
    const tnf = flags & 0x07
    const typeLen = bytes[i++]
    let payloadLen: number
    if (sr) payloadLen = bytes[i++]
    else {
      if (i + 4 > bytes.length) break
      payloadLen = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]
      i += 4
    }
    let idLen = 0
    if (il) idLen = bytes[i++]
    if (i + typeLen + idLen + payloadLen > bytes.length) break
    const type = bytes.slice(i, i + typeLen); i += typeLen
    const id = bytes.slice(i, i + idLen); i += idLen
    const payload = bytes.slice(i, i + payloadLen); i += payloadLen
    const typeStr = String.fromCharCode(...type)
    const rec: NdefRecord = {
      tnf,
      type: typeStr,
      id: String.fromCharCode(...id),
      payload,
    }
    if (tnf === 0x01 && typeStr === "T" && payload.length >= 1) {
      const status = payload[0]
      const langLen = status & 0x3f
      const textBytes = payload.slice(1 + langLen)
      rec.text = new TextDecoder().decode(Uint8Array.from(textBytes))
    }
    if (tnf === 0x01 && typeStr === "U" && payload.length >= 1) {
      const prefix = URI_PREFIXES[payload[0]] ?? ""
      rec.uri = prefix + new TextDecoder().decode(Uint8Array.from(payload.slice(1)))
    }
    records.push(rec)
    if (me) break
  }
  return records
}

/** Extract first NDEF TLV (0x03) from NTAG user memory dump. */
export function extractNdefTlv(pages: number[]): number[] | null {
  let i = 0
  while (i < pages.length) {
    const t = pages[i++]
    if (t === 0x00) continue // NULL TLV padding
    if (t === 0xfe) break // terminator
    if (i >= pages.length) break
    let len = pages[i++]
    if (len === 0xff) {
      if (i + 1 >= pages.length) break
      len = (pages[i] << 8) | pages[i + 1]; i += 2
    }
    const value = pages.slice(i, i + len); i += len
    if (t === 0x03) return value
  }
  return null
}

/* ---------------- NDEF encoding (for writing tags) ---------------- */

export type NdefWriteRecord =
  | { kind: 'text'; text: string; lang?: string }
  | { kind: 'number'; value: string }
  | { kind: 'uri'; uri: string }

function encodeRecord(opts: {
  mb: boolean
  me: boolean
  tnf: number
  type: string
  payload: number[]
  id?: number[]
}): number[] {
  const typeBytes = [...opts.type].map((c) => c.charCodeAt(0))
  const id = opts.id ?? []
  if (typeBytes.length > 255) throw new Error('Record type too long')
  const sr = opts.payload.length < 256
  const flags =
    (opts.mb ? 0x80 : 0) |
    (opts.me ? 0x40 : 0) |
    (sr ? 0x10 : 0) |
    (id.length ? 0x08 : 0) |
    (opts.tnf & 0x07)
  const out = [flags, typeBytes.length]
  if (sr) {
    out.push(opts.payload.length)
  } else {
    out.push(
      (opts.payload.length >>> 24) & 0xff,
      (opts.payload.length >>> 16) & 0xff,
      (opts.payload.length >>> 8) & 0xff,
      opts.payload.length & 0xff,
    )
  }
  if (id.length) out.push(id.length)
  out.push(...typeBytes, ...id, ...opts.payload)
  return out
}

function textPayload(text: string, lang: string): number[] {
  const langBytes = [...lang].map((c) => c.charCodeAt(0))
  if (langBytes.length === 0 || langBytes.length > 63) {
    throw new Error('Language code must be 1–63 ASCII chars (e.g. "en")')
  }
  if (!/^[\x00-\x7F]*$/.test(lang)) throw new Error('Language code must be ASCII')
  const textBytes = [...new TextEncoder().encode(text)]
  if (textBytes.length > 2000) throw new Error('Text too long for a single record')
  return [(langBytes.length & 0x3f), ...langBytes, ...textBytes] // status: UTF-8
}

function uriPayload(uri: string): number[] {
  let best = 0
  for (let i = 1; i < URI_PREFIXES.length; i++) {
    const p = URI_PREFIXES[i]!
    if (uri.startsWith(p) && p.length > URI_PREFIXES[best]!.length) best = i
  }
  const rest = [...new TextEncoder().encode(uri.slice(URI_PREFIXES[best]!.length))]
  return [best, ...rest]
}

/** Build an NDEF message from high-level records (MB/ME/SR flags handled). */
export function buildNdefMessage(records: NdefWriteRecord[]): number[] {
  if (records.length === 0) throw new Error('Add at least one record')
  if (records.length > 8) throw new Error('Max 8 records per write')
  const out: number[] = []
  records.forEach((r, i) => {
    const mb = i === 0
    const me = i === records.length - 1
    if (r.kind === 'text') {
      if (!r.text) throw new Error('Text record is empty')
      out.push(...encodeRecord({ mb, me, tnf: 0x01, type: 'T', payload: textPayload(r.text, r.lang ?? 'en') }))
    } else if (r.kind === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(r.value.trim())) throw new Error(`"${r.value}" is not a plain number`)
      out.push(...encodeRecord({ mb, me, tnf: 0x01, type: 'T', payload: textPayload(r.value.trim(), 'en') }))
    } else {
      if (!r.uri.trim()) throw new Error('URL record is empty')
      out.push(...encodeRecord({ mb, me, tnf: 0x01, type: 'U', payload: uriPayload(r.uri.trim()) }))
    }
  })
  return out
}

/** Wrap a message in an NDEF TLV (0x03 … 0xFE), padded to a 4-byte boundary
 *  for NTAG page writes. */
export function buildNdefTlv(msg: number[]): number[] {
  const out = [0x03]
  if (msg.length >= 255) {
    out.push(0xff, (msg.length >>> 8) & 0xff, msg.length & 0xff)
  } else {
    out.push(msg.length)
  }
  out.push(...msg, 0xfe)
  while (out.length % 4 !== 0) out.push(0x00)
  return out
}

export interface CapabilityContainer {
  magic: boolean
  version: number
  sizeBytes: number
  readWrite: boolean
}

/** Parse NTAG capability container (page 3: E1 ver size access). */
export function parseCapabilityContainer(page3: number[]): CapabilityContainer {
  if (page3.length < 4) throw new Error('Short CC page')
  return {
    magic: page3[0] === 0xe1,
    version: page3[1] ?? 0,
    sizeBytes: (page3[2] ?? 0) * 8,
    readWrite: (page3[3] ?? 0) === 0x00,
  }
}
