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
