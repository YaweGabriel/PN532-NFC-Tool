/**
 * PN532 HSU (High Speed UART) frame codec.
 * Reference: NXP PN532/C1 user manual §6 / HSU link protocol.
 *
 * Host→PN532 normal frame:
 *   00 00 FF LEN LCS [TFI=D4 CMD PARAMS...] DCS 00
 * PN532→Host:
 *   ACK  = 00 00 FF 00 FF 00
 *   NACK = 00 00 FF FF 00 00
 *   Response frame: 00 00 FF LEN LCS [TFI=D5 RSP ...] DCS 00
 * Extended frames (LEN=0xFF 0xFF + 2-byte len) supported on decode.
 */

export const PREAMBLE = [0x00, 0x00, 0xff] as const
export const POSTAMBLE = 0x00
export const TFI_HOST_TO_PN532 = 0xd4
export const TFI_PN532_TO_HOST = 0xd5
export const ACK_FRAME = [0x00, 0x00, 0xff, 0x00, 0xff, 0x00]
export const NACK_FRAME = [0x00, 0x00, 0xff, 0xff, 0x00, 0x00]
export const ERROR_FRAME = [0x00, 0x00, 0xff, 0x01, 0xff, 0x7f, 0x81, 0x00]

function checksum(bytes: number[]): number {
  let sum = 0
  for (const b of bytes) sum = (sum + b) & 0xff
  return ((~sum + 1) & 0xff)
}

export function encodeCommand(cmd: number, params: number[] = []): Uint8Array {
  const body = [TFI_HOST_TO_PN532, cmd, ...params]
  if (body.length > 255) throw new Error("Use extended frame for payloads > 255 (not needed for v1 commands)")
  const len = body.length
  return Uint8Array.from([...PREAMBLE, len, checksum([len]), ...body, checksum(body), POSTAMBLE])
}

export interface DecodedFrame {
  kind: "ack" | "nack" | "error" | "response"
  command?: number
  data: number[]
  raw: number[]
}

export function tryDecodeOne(buf: number[]): { frame: DecodedFrame; consumed: number } | null {
  // Find preamble 00 00 FF
  let start = -1
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00 && buf[i + 2] === 0xff) { start = i; break }
  }
  if (start < 0) return null
  if (start > 0) {
    // garbage before preamble — consume it
    return { frame: { kind: "response", data: [], raw: buf.slice(0, start) }, consumed: start }
  }
  if (buf.length < start + 6) return null
  const len = buf[start + 3]
  const lcs = buf[start + 4]
  // ACK / NACK are special frames that intentionally violate LEN+LCS=0
  if (len === 0x00 && lcs === 0xff) {
    const raw = buf.slice(start, start + 6)
    return { frame: { kind: "ack", data: [], raw }, consumed: 6 }
  }
  if (len === 0xff && lcs === 0x00) {
    const raw = buf.slice(start, start + 6)
    return { frame: { kind: "nack", data: [], raw }, consumed: 6 }
  }
  if (((len + lcs) & 0xff) !== 0) throw new Error(`Bad length checksum LEN=${len} LCS=${lcs}`)
  if (len === 0xff && lcs === 0xff) {
    // extended frame
    if (buf.length < start + 9) return null
    const lenM = buf[start + 5], lenL = buf[start + 6]
    const extLen = (lenM << 8) | lenL
    const extLcs = buf[start + 7]
    if ((((lenM + lenL + extLcs) & 0xff)) !== 0) throw new Error("Bad extended length checksum")
    const total = 3 + 2 + 3 + extLen + 2
    if (buf.length < start + total) return null
    const body = buf.slice(start + 8, start + 8 + extLen)
    const dcs = buf[start + 8 + extLen]
    if (((body.reduce((a, b) => a + b, 0) + dcs) & 0xff) !== 0) throw new Error("Bad extended DCS")
    const raw = buf.slice(start, start + total)
    return { frame: decodeBody(body, raw), consumed: total }
  }
  const total = 3 + 2 + len + 2
  if (buf.length < start + total) return null
  const body = buf.slice(start + 5, start + 5 + len)
  const dcs = buf[start + 5 + len]
  if (((body.reduce((a, b) => a + b, 0) + dcs) & 0xff) !== 0) throw new Error("Bad data checksum (DCS)")
  const raw = buf.slice(start, start + total)
  return { frame: decodeBody(body, raw), consumed: total }
}

function decodeBody(body: number[], raw: number[]): DecodedFrame {
  const tfi = body[0]
  if (tfi === TFI_PN532_TO_HOST) {
    return { kind: "response", command: body[1], data: body.slice(2), raw }
  }
  if (body.length === 2 && body[0] === 0x7f && body[1] === 0x81) {
    return { kind: "error", data: [], raw }
  }
  return { kind: "response", command: body[1], data: body.slice(2), raw }
}

export function decodeStream(chunks: number[][]): { frames: DecodedFrame[]; rest: number[] } {
  let buf: number[] = chunks.flat()
  const frames: DecodedFrame[] = []
  for (;;) {
    // skip leading zeros garbage except preamble search handles it
    const r = tryDecodeOne(buf)
    if (!r) break
    if (!(r.frame.kind === "response" && r.frame.raw.length === 0 && r.frame.data.length === 0)) {
      // filter pure garbage-consumed pseudo frames: re-scan them
      if (r.frame.raw.length > 0 && r.frame.kind === "response" && r.consumed > 0 && r.frame.data.length === 0 && r.frame.command === undefined) {
        buf = buf.slice(r.consumed)
        continue
      }
      frames.push(r.frame)
    }
    buf = buf.slice(r.consumed)
  }
  return { frames, rest: buf }
}
