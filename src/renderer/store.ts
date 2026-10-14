import { create } from 'zustand'

export interface PortInfo {
  path: string
  manufacturer?: string
  friendly?: string
}

export interface TargetInfo {
  found: boolean
  at?: string
  uid?: string
  sak?: string
  ats?: string
  type?: string
  raw?: string
}

export interface LogEntry {
  id: number
  ts: string
  dir: 'tx' | 'rx' | 'info' | 'error'
  label: string
  hex?: string
}

interface State {
  ports: PortInfo[]
  port: string
  baud: number
  connected: boolean
  mock: boolean
  firmware: string | null
  target: TargetInfo | null
  polling: boolean
  logs: LogEntry[]
  busy: boolean
  error: string | null
  tab: 'reader' | 'tags' | 'console' | 'scan'
  dark: boolean
  set: (p: Partial<State>) => void
  pushLog: (e: LogEntry) => void
  clearLogs: () => void
}

export const useStore = create<State>((set) => ({
  ports: [],
  port: '',
  baud: 115200,
  connected: false,
  mock: false,
  firmware: null,
  target: null,
  polling: false,
  logs: [],
  busy: false,
  error: null,
  tab: 'reader',
  dark: false,
  set: (p) => set(p),
  pushLog: (e) =>
    set((s) => ({ logs: [...s.logs.slice(-499), e] })),
  clearLogs: () => set({ logs: [] }),
}))

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pn532: any
  }
}

export const api = (): Window['pn532'] => window.pn532
