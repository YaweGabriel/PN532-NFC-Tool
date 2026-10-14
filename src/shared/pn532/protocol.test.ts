import { describe, it, expect } from 'vitest'
import { parseFirmwareVersion, samConfigParams } from './commands'
import {
  decodeNdefMessage,
  extractNdefTlv,
  buildNdefMessage,
  buildNdefTlv,
  parseCapabilityContainer,
} from './ndef'

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

describe('ndef encode', () => {
  it('round-trips a text record', () => {
    const msg = buildNdefMessage([{ kind: 'text', text: 'hello', lang: 'en' }])
    const recs = decodeNdefMessage(msg)
    expect(recs).toHaveLength(1)
    expect(recs[0]?.text).toBe('hello')
    // MB|ME|SR|TNF1 header, type 'T'
    expect(msg[0]).toBe(0xd1)
  })

  it('round-trips a URI record with prefix compression', () => {
    const msg = buildNdefMessage([{ kind: 'uri', uri: 'https://example.com/x' }])
    const recs = decodeNdefMessage(msg)
    expect(recs[0]?.uri).toBe('https://example.com/x')
    // payload[0] should be the https:// prefix index (0x04), not literal text
    expect(msg[msg.indexOf(0x55) + 1]).toBe(0x04)
  })

  it('stores numbers as text and rejects junk', () => {
    const msg = buildNdefMessage([{ kind: 'number', value: '-12.5' }])
    expect(decodeNdefMessage(msg)[0]?.text).toBe('-12.5')
    expect(() => buildNdefMessage([{ kind: 'number', value: '12a' }])).toThrow()
  })

  it('builds a padded TLV', () => {
    const tlv = buildNdefTlv([0xd1, 0x01, 0x00, 0x55])
    expect(tlv[0]).toBe(0x03)
    expect(tlv).toContain(0xfe)
    expect(tlv.length % 4).toBe(0)
    expect(extractNdefTlv(tlv)).toEqual([0xd1, 0x01, 0x00, 0x55])
  })

  it('parses NTAG213 capability container', () => {
    const cc = parseCapabilityContainer([0xe1, 0x10, 0x12, 0x00])
    expect(cc.magic).toBe(true)
    expect(cc.sizeBytes).toBe(144)
    expect(cc.readWrite).toBe(true)
  })
})
