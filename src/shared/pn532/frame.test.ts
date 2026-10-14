import { describe, it, expect } from 'vitest'
import { encodeCommand, tryDecodeOne, ACK_FRAME } from './frame'

describe('HSU frame codec', () => {
  it('encodes GetFirmwareVersion', () => {
    const f = [...encodeCommand(0x02)]
    expect(f.slice(0, 3)).toEqual([0x00, 0x00, 0xff])
    // LEN=2 (D4 02), LCS, D4 02, DCS, 00
    expect(f).toEqual([0x00, 0x00, 0xff, 0x02, 0xfe, 0xd4, 0x02, 0x2a, 0x00])
  })

  it('decodes ACK', () => {
    const r = tryDecodeOne([...ACK_FRAME])
    expect(r?.frame.kind).toBe('ack')
    expect(r?.consumed).toBe(6)
  })

  it('round-trips a response frame', () => {
    // PN532 GetFirmwareVersion response: D5 03 32 01 06 07
    const body = [0xd5, 0x03, 0x32, 0x01, 0x06, 0x07]
    const len = body.length
    const lcs = ((~len + 1) & 0xff)
    const dcs = ((~(body.reduce((a, b) => a + b, 0)) + 1) & 0xff)
    const raw = [0x00, 0x00, 0xff, len, lcs, ...body, dcs, 0x00]
    const r = tryDecodeOne(raw)
    expect(r?.frame.kind).toBe('response')
    expect(r?.frame.command).toBe(0x03)
    expect(r?.frame.data).toEqual([0x32, 0x01, 0x06, 0x07])
  })

  it('rejects bad checksum', () => {
    expect(() => tryDecodeOne([0x00, 0x00, 0xff, 0x02, 0x00, 0xd4, 0x02, 0x2a, 0x00])).toThrow()
  })
})
