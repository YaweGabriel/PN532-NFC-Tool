import { describe, it, expect } from 'vitest'
import { parseFirmwareVersion, samConfigParams } from './commands'
import { decodeNdefMessage, extractNdefTlv } from './ndef'

describe('commands', () => {
  it('parses firmware version', () => {
    const fw = parseFirmwareVersion([0x32, 0x01, 0x06, 0x07])
    expect(fw.label).toBe('PN532 v1.6')
  })
  it('builds SAM params', () => {
    expect(samConfigParams()).toEqual([0x01, 0x14, 0x01])
  })
})

describe('ndef', () => {
  it('decodes URI record', () => {
    // NDEF: MB|ME|SR|TNF=1, typeLen=1, payloadLen, 'U', payload 0x01 + "example.com"
    const payload = [0x01, ...[...'example.com'].map((c) => c.charCodeAt(0))]
    const msg = [0xd1, 0x01, payload.length, 0x55, ...payload]
    const recs = decodeNdefMessage(msg)
    expect(recs[0]?.uri).toBe('http://www.example.com')
  })
  it('extracts TLV', () => {
    const tlv = extractNdefTlv([0x03, 0x03, 0xd1, 0x00, 0x00, 0xfe, 0x00])
    expect(tlv).toEqual([0xd1, 0x00, 0x00])
  })
})
