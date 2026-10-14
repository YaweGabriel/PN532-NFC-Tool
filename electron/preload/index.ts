import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listPorts: (): Promise<Array<{ path: string; manufacturer?: string; friendly?: string }>> =>
    ipcRenderer.invoke('ports:list'),
  echoTest: (port: string, baud = 115200) => ipcRenderer.invoke('adapter:echo', port, baud),
  connect: (port: string, baud = 115200) => ipcRenderer.invoke('pn532:connect', port, baud),
  disconnect: () => ipcRenderer.invoke('pn532:disconnect'),
  status: () => ipcRenderer.invoke('pn532:status'),
  firmware: () => ipcRenderer.invoke('pn532:firmware'),
  samConfig: () => ipcRenderer.invoke('pn532:sam-config'),
  pollOnce: (timeoutMs = 1500) => ipcRenderer.invoke('pn532:poll-once', timeoutMs),
  pollStart: (intervalMs = 1200) => ipcRenderer.invoke('pn532:poll-start', intervalMs),
  pollStop: () => ipcRenderer.invoke('pn532:poll-stop'),
  mifareRead: (args: { block: number; key: string; keyType: 'A' | 'B' }) =>
    ipcRenderer.invoke('pn532:mifare-read', args),
  mifareWrite: (args: { block: number; key: string; keyType: 'A' | 'B'; dataHex: string }) =>
    ipcRenderer.invoke('pn532:mifare-write', args),
  ntagRead: (page: number) => ipcRenderer.invoke('pn532:ntag-read', { page }),
  ntagWrite: (page: number, dataHex: string) => ipcRenderer.invoke('pn532:ntag-write', { page, dataHex }),
  raw: (commandHex: string, timeoutMs = 2000) => ipcRenderer.invoke('pn532:raw', { commandHex, timeoutMs }),
  onTarget: (cb: (t: unknown) => void) => {
    const fn = (_e: unknown, t: unknown) => cb(t)
    ipcRenderer.on('pn532:target', fn)
    return () => ipcRenderer.removeListener('pn532:target', fn)
  },
  onLog: (cb: (e: unknown) => void) => {
    const fn = (_e: unknown, entry: unknown) => cb(entry)
    ipcRenderer.on('pn532:log', fn)
    return () => ipcRenderer.removeListener('pn532:log', fn)
  },
}

contextBridge.exposeInMainWorld('pn532', api)
export type Pn532Api = typeof api
