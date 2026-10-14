/** PN532 command codes + helpers (NXP PN532/C1 manual §7). */
export const CMD = {
  Diagnose: 0x00,
  GetFirmwareVersion: 0x02,
  GetGeneralStatus: 0x04,
  ReadRegister: 0x06,
  WriteRegister: 0x08,
  ReadGPIO: 0x0c,
  WriteGPIO: 0x0e,
  SetSerialBaudRate: 0x10,
  SetParameters: 0x12,
  SAMConfiguration: 0x14,
  PowerDown: 0x16,
  RFConfiguration: 0x32,
  RFRegulationTest: 0x58,
  InJumpForDEP: 0x56,
  InJumpForPSL: 0x46,
  InListPassiveTarget: 0x4a,
  InATR: 0x50,
  InPSL: 0x4e,
  InDataExchange: 0x40,
  InCommunicateThru: 0x42,
  InDeselect: 0x44,
  InRelease: 0x52,
  InSelect: 0x54,
  InAutoPoll: 0x60,
  TgInitAsTarget: 0x8c,
  TgGetData: 0x86,
  TgSetData: 0x8e,
} as const

export interface FirmwareInfo {
  ic: number
  ver: number
  rev: number
  support: number
  raw: number[]
  label: string
}

export function parseFirmwareVersion(data: number[]): FirmwareInfo {
  // Response data for 0x02: [IC, Ver, Rev, Support]
  if (data.length < 4) throw new Error(`Short firmware response: ${data.length} bytes`)
  const [ic, ver, rev, support] = data
  return { ic, ver, rev, support, raw: [...data], label: `PN5${ic.toString(16).toUpperCase()} v${ver}.${rev}` }
}

export function samConfigParams(mode = 0x01, timeout = 0x14, irq = 0x01): number[] {
  return [mode, timeout, irq]
}

export function inListPassiveTargetParams(maxTg = 0x01, brTy: number[] = [0x00]): number[] {
  // brTy 0x00 = 106 kbps ISO14443A/MIFARE
  return [maxTg, ...brTy]
}

export function mifareAuthParams(block: number, key: number[], uid: number[], keyTypeA = true): number[] {
  return [0x01, keyTypeA ? 0x60 : 0x61, block, ...key, ...uid]
}

export const MIFARE_KEY_DEFAULT_FF = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
export const MIFARE_KEY_DEFAULT_00 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
