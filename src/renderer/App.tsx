import { useEffect } from 'react'
import { useRef } from 'react'
import { Moon, Sun, Nfc, Tags, TerminalSquare, Trash2, PlugZap, Unplug, RefreshCw, Radio, ScanLine, ShieldAlert, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge, Input, Label, Select } from '@/components/ui/primitives'
import { useStore, api, type LogEntry, type TargetInfo } from '@/store'
import { toHex } from '@/lib/utils'
import { decodeNdefMessage, extractNdefTlv, buildNdefMessage, buildNdefTlv, type NdefWriteRecord } from '@shared/pn532/ndef'
import { useState } from 'react'

function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-6 pb-16">{children}</div>
}
function PageHeader({ title, desc, right }: { title: string; desc: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 py-8">
      <div>
        <p className="eyebrow text-muted-foreground">PN532 Studio</p>
        <h1 className="heading text-4xl mt-2">{title}</h1>
        <p className="text-sm text-muted-foreground mt-2 max-w-xl">{desc}</p>
      </div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  )
}

function usePn532Events() {
  const pushLog = useStore((s) => s.pushLog)
  const set = useStore((s) => s.set)
  useEffect(() => {
    const offLog = api().onLog((e: LogEntry) => pushLog(e))
    const offT = api().onTarget((t: TargetInfo) => {
      if (t?.found) set({ target: t })
    })
    return () => {
      offLog?.()
      offT?.()
    }
  }, [pushLog, set])
}

function ConnectionBar() {
  const { ports, port, baud, connected, mock, busy, set } = useStore()
  const [echo, setEcho] = useState<string | null>(null)
  const [echoBusy, setEchoBusy] = useState(false)
  const refresh = async () => {
    set({ busy: true, error: null })
    try {
      const list = await api().listPorts()
      set({ ports: [...list, { path: '__mock__', friendly: 'Mock device (no hardware)' }] })
      if (!port && list.length) set({ port: list[0]!.path })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = async () => {
    if (!port) return
    useStore.getState().set({ busy: true, error: null })
    try {
      const r = await api().connect(port, baud)
      const st = await api().status()
      set({ connected: true, mock: st.mock, firmware: st.firmware, error: null })
      void pushInitial(r)
    } catch (e) {
      set({ error: (e as Error).message, connected: false })
    } finally {
      set({ busy: false })
    }
    async function pushInitial(_r: unknown) {
      void _r
    }
  }
  const disconnect = async () => {
    await api().disconnect()
    set({ connected: false, mock: false, polling: false, target: null, firmware: null })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection</CardTitle>
        <CardDescription>Plug in your reader, choose its port, and connect.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-[1fr_140px_auto_auto_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="port">Serial port</Label>
            <Select id="port" value={port} onChange={(e) => set({ port: e.target.value })}>
              <option value="">— select —</option>
              {ports.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.friendly ?? p.path}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="baud">Baud</Label>
            <Select id="baud" value={String(baud)} onChange={(e) => set({ baud: Number(e.target.value) })}>
              <option value="115200">115200</option>
              <option value="57600">57600</option>
              <option value="19200">19200</option>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button variant="outline" size="icon" onClick={refresh} aria-label="Refresh ports" disabled={busy}>
              <RefreshCw className="size-4" />
            </Button>
            {connected ? (
              <Button variant="destructive" onClick={disconnect}>
                <Unplug className="size-4" /> Disconnect
              </Button>
            ) : (
              <Button variant="ink" onClick={connect} loading={busy} disabled={!port}>
                <PlugZap className="size-4" /> Connect
              </Button>
            )}
          </div>
          <div className="flex items-end">
            {connected ? (
              <Badge variant={mock ? 'warning' : 'success'}>{mock ? 'mock link' : 'hardware link'}</Badge>
            ) : (
              <Badge variant="outline">disconnected</Badge>
            )}
          </div>
        </div>
        <details className="mt-4 rounded-md border bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Reader not responding? Test the adapter
          </summary>
          <p className="mt-2 text-sm text-muted-foreground">
            Unplug the reader, join the adapter's <span className="font-mono">TX</span> and{' '}
            <span className="font-mono">RX</span> pins with a short wire, then run the test. A{' '}
            <span className="font-mono">PASS</span> means your computer side works and the problem is on the reader itself.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!port || port === '__mock__' || echoBusy}
              loading={echoBusy}
              onClick={async () => {
                setEchoBusy(true)
                setEcho(null)
                try {
                  const r = await api().echoTest(port, baud)
                  setEcho(`${r.ok ? 'PASS' : 'FAIL'} — ${r.message} (TX ${r.sent} / RX ${r.received || '—'})`)
                } catch (e) {
                  setEcho(`ERROR — ${(e as Error).message}`)
                } finally {
                  setEchoBusy(false)
                }
              }}
            >
              Run loopback test
            </Button>
          </div>
          {echo && <p className="mt-2 font-mono text-xs whitespace-pre-wrap">{echo}</p>}
        </details>
      </CardContent>
    </Card>
  )
}

function ReaderTab() {
  const { connected, firmware, target, polling, busy, error, set } = useStore()
  const pollOnce = async () => {
    set({ busy: true, error: null })
    try {
      const t = await api().pollOnce(1500)
      set({ target: t.found ? t : null })
      if (!t.found) set({ error: 'No card in field. Hold a tag 1–3 cm from the antenna.' })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  }
  const togglePoll = async () => {
    if (polling) {
      await api().pollStop()
      set({ polling: false })
    } else {
      await api().pollStart(1200)
      set({ polling: true })
    }
  }
  const readFw = async () => {
    set({ busy: true, error: null })
    try {
      const fw = await api().firmware()
      set({ firmware: fw.label })
      await api().samConfig()
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Reader</CardTitle>
          <CardDescription>Check the reader and look for nearby cards.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            <div className="flex items-center justify-between rounded-md border bg-surface px-3 py-2">
              <span className="font-mono text-xs text-muted-foreground">FIRMWARE</span>
              <span className="font-mono text-sm">{firmware ?? '—'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={readFw} disabled={!connected} loading={busy}>
                Check reader
              </Button>
              <Button variant="default" onClick={pollOnce} disabled={!connected} loading={busy}>
                <Radio className="size-4" /> Poll once
              </Button>
              <Button variant={polling ? 'destructive' : 'secondary'} onClick={togglePoll} disabled={!connected}>
                {polling ? 'Stop polling' : 'Auto-poll'}
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!connected && <p className="text-sm text-muted-foreground">Connect first. Tip: use Mock device to explore without hardware.</p>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Target in field</CardTitle>
          <CardDescription>{target?.found ? `${target.type} · ${target.at}` : 'No target yet'}</CardDescription>
        </CardHeader>
        <CardContent>
          {target?.found ? (
            <div className="grid gap-2">
              <dl className="grid gap-2 font-mono text-sm">
                <div className="flex justify-between border-b py-1.5"><dt className="font-sans text-muted-foreground">Card ID</dt><dd>{target.uid}</dd></div>
                <div className="flex justify-between py-1.5"><dt className="font-sans text-muted-foreground">Card type</dt><dd>{target.type}</dd></div>
              </dl>
              <details className="rounded-md border bg-surface px-3 py-2">
                <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-muted-foreground">Technical details</summary>
                <dl className="mt-2 grid gap-1.5 font-mono text-xs">
                  <div className="flex justify-between"><dt className="text-muted-foreground">SAK</dt><dd>{target.sak}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">Raw</dt><dd className="break-all text-right">{target.raw}</dd></div>
                </dl>
              </details>
            </div>
          ) : (
            <div className="bg-dots rounded-md border p-8 text-center">
              <Nfc className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">Hold a card or tag close to the antenna.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function TagsTab() {
  const { connected, target, set } = useStore()
  const [block, setBlock] = useState(4)
  const [key, setKey] = useState('FFFFFFFFFFFF')
  const [keyType, setKeyType] = useState<'A' | 'B'>('A')
  const [dataHex, setDataHex] = useState('00112233445566778899AABBCCDDEEFF')
  const [out, setOut] = useState('')
  const [page, setPage] = useState(4)
  const [pageHex, setPageHex] = useState('DEADBEEF')
  const [ndef, setNdef] = useState('')
  const busy = useStore((s) => s.busy)

  const run = async (fn: () => Promise<unknown>, label: string) => {
    set({ busy: true, error: null })
    try {
      const r = await fn()
      setOut(`${label}: ${JSON.stringify(r)}`)
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  }

  const dumpNdef = async () => {
    set({ busy: true, error: null })
    try {
      const bytes: number[] = []
      for (let p = 4; p < 4 + 32; p++) {
        const r = await api().ntagRead(p)
        bytes.push(...(r.bytes as number[]).slice(0, 4))
        if (bytes.length >= 128) break
      }
      const tlv = extractNdefTlv(bytes)
      if (!tlv) {
        setNdef('No NDEF TLV found. Tag may be unformatted.')
        return
      }
      const recs = decodeNdefMessage(tlv)
      setNdef(recs.length ? recs.map((r) => r.text ?? r.uri ?? `${r.type}:${toHex(r.payload, '')}`).join('\n') : `NDEF (${tlv.length}B): ${toHex(tlv, ' ')}`)
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  }

  return (
    <div className="grid gap-4">
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>MIFARE Classic</CardTitle>
          <CardDescription>Read and write card blocks with a key. Protected blocks stay locked.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-1.5"><Label>Block</Label><Input type="number" min={0} max={63} value={block} onChange={(e) => setBlock(Number(e.target.value))} /></div>
              <div className="grid gap-1.5"><Label>Key type</Label>
                <Select value={keyType} onChange={(e) => setKeyType(e.target.value as 'A' | 'B')}><option value="A">Key A</option><option value="B">Key B</option></Select>
              </div>
              <div className="grid gap-1.5"><Label>Key</Label><Input value={key} onChange={(e) => setKey(e.target.value)} /></div>
            </div>
            <div className="grid gap-1.5"><Label>Block data</Label><Input value={dataHex} onChange={(e) => setDataHex(e.target.value)} /></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!connected} loading={busy} onClick={() => run(() => api().mifareRead({ block, key, keyType }), 'READ')}>Read block</Button>
              <Button variant="ink" disabled={!connected || !target?.found} loading={busy} onClick={() => run(() => api().mifareWrite({ block, key, keyType, dataHex }), 'WRITE')}>Write block</Button>
            </div>
            {out && <pre className="rounded-md border bg-surface p-3 font-mono text-xs whitespace-pre-wrap">{out}</pre>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>NTAG / Ultralight + NDEF</CardTitle>
          <CardDescription>Read and write small memory pages, or see what's stored on the tag.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5"><Label>Page</Label><Input type="number" min={4} max={135} value={page} onChange={(e) => setPage(Number(e.target.value))} /></div>
              <div className="grid gap-1.5"><Label>Page data</Label><Input value={pageHex} onChange={(e) => setPageHex(e.target.value)} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!connected} loading={busy} onClick={() => run(() => api().ntagRead(page), 'PAGE')}>Read page</Button>
              <Button variant="secondary" disabled={!connected} loading={busy} onClick={() => run(() => api().ntagWrite(page, pageHex), 'WROTE')}>Write page</Button>
              <Button variant="default" disabled={!connected} loading={busy} onClick={dumpNdef}>Decode NDEF</Button>
            </div>
            {ndef && <pre className="rounded-md border bg-surface p-3 font-mono text-xs whitespace-pre-wrap">{ndef}</pre>}
          </div>
        </CardContent>
      </Card>
    </div>
    <NdefWriteCard />
    </div>
  )
}

function NdefWriteCard() {
  const connected = useStore((s) => s.connected)
  const busy = useStore((s) => s.busy)
  const set = useStore((s) => s.set)
  const [kind, setKind] = useState<'text' | 'number' | 'uri'>('text')
  const [value, setValue] = useState('Hello NFC')
  const [lang, setLang] = useState('en')
  const [result, setResult] = useState('')

  const preview = (() => {
    try {
      const rec: NdefWriteRecord =
        kind === 'text' ? { kind: 'text', text: value, lang: lang || 'en' }
        : kind === 'number' ? { kind: 'number', value }
        : { kind: 'uri', uri: value }
      const tlv = buildNdefTlv(buildNdefMessage([rec]))
      return { ok: true as const, tlv, bytes: tlv.length, pages: tlv.length / 4 }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })()

  const write = async () => {
    if (!preview.ok) return
    set({ busy: true, error: null })
    setResult('')
    try {
      const r = await api().ndefWrite(preview.tlv) as { pages: number; bytes: number; capacity: number; verify: string }
      setResult(`WROTE ${r.bytes}B in ${r.pages} pages (tag capacity ${r.capacity}B)\nRead-back: ${r.verify}`)
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Write text · number · URL to tag</CardTitle>
        <CardDescription>
          Write a message to the tag. The app checks the tag has room first and never touches
          its protected area. Hold the tag steady until it finishes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-[180px_1fr_140px]">
          <div className="grid gap-1.5">
            <Label>Record type</Label>
            <Select value={kind} onChange={(e) => {
              const k = e.target.value as 'text' | 'number' | 'uri'
              setKind(k)
              setValue(k === 'text' ? 'Hello NFC' : k === 'number' ? '42' : 'https://example.com')
            }}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="uri">URL</option>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{kind === 'text' ? 'Text' : kind === 'number' ? 'Number' : 'URL'}</Label>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'uri' ? 'https://…' : kind === 'number' ? '42' : 'Hello NFC'} />
          </div>
          {kind === 'text' ? (
            <div className="grid gap-1.5">
              <Label>Language</Label>
              <Input value={lang} onChange={(e) => setLang(e.target.value)} placeholder="en" maxLength={8} />
            </div>
          ) : <div />}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="ink" onClick={write} disabled={!connected || !preview.ok || !value} loading={busy}>
            Write to tag
          </Button>
          {preview.ok ? (
            <span className="font-mono text-xs text-muted-foreground">
              {preview.bytes} bytes · {preview.pages} pages{preview.bytes > 144 ? ' — too big for small tags, shorten it' : ''}
            </span>
          ) : (
            <span className="font-mono text-xs text-destructive">{preview.error}</span>
          )}
        </div>
        {result && <pre className="mt-3 rounded-md border bg-surface p-3 font-mono text-xs whitespace-pre-wrap">{result}</pre>}
      </CardContent>
    </Card>
  )
}

function UrlPermissionModal({ uri, onAllow, onDeny }: { uri: string; onAllow: () => void; onDeny: () => void }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDeny()
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onDeny])

  let host = uri
  try {
    host = new URL(uri).hostname || uri
  } catch {
    /* show raw */
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="url-modal-title">
      <div className="absolute inset-0 bg-ink/40" onClick={onDeny} aria-hidden />
      <div className="relative w-full max-w-md rounded-lg border bg-popover p-6 text-popover-foreground shadow-xl">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-warning/15 text-warning">
            <ShieldAlert className="size-5" />
          </span>
          <div>
            <h2 id="url-modal-title" className="heading text-xl">Open external link?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This NFC tag wants to open a web page. Links leave this app — only continue if you trust the tag.
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-md border bg-surface px-3 py-2.5">
          <p className="font-mono text-xs break-all">{uri}</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">domain: {host}</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onDeny} autoFocus>Stay here</Button>
          <Button variant="ink" onClick={onAllow}><ExternalLink className="size-4" /> Open link</Button>
        </div>
        <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Esc / backdrop = stay · asked once per tag
        </p>
      </div>
    </div>
  )
}

interface ScanResult {
  uid?: string
  type?: string
  texts: string[]
  uris: string[]
  note?: string
}

function ScanTab() {
  const connected = useStore((s) => s.connected)
  const busy = useStore((s) => s.busy)
  const set = useStore((s) => s.set)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [pendingUrl, setPendingUrl] = useState<{ uri: string; key: string } | null>(null)
  const [auto, setAuto] = useState(false)
  const seen = useRef(new Set<string>())

  const readTag = async (silent = false) => {
    if (!silent) {
      set({ busy: true, error: null })
      setResult(null)
    }
    try {
      const t = (await api().pollOnce(1500)) as TargetInfo
      if (!t?.found) {
        if (!silent) set({ error: 'No card in field. Hold a tag 1–3 cm from the antenna and retry.' })
        return
      }
      const type = t.type ?? ''
      const isType2 = type.includes('NTAG') || type.includes('Ultralight') || t.sak === '00'
      if (!isType2) {
        setResult({
          uid: t.uid, type: t.type, texts: [], uris: [],
          note: `UID ${t.uid ?? '?'} (${type || 'unknown type'}). Auto-read covers NTAG/Ultralight here — use the Tags tab for MIFARE Classic blocks.`,
        })
        return
      }
      const bytes: number[] = []
      for (let p = 4; p < 36; p++) {
        const r = await api().ntagRead(p)
        bytes.push(...((r.bytes as number[]) ?? []).slice(0, 4))
      }
      const tlv = extractNdefTlv(bytes)
      const recs = tlv ? decodeNdefMessage(tlv) : []
      const texts = recs.map((r) => r.text).filter((x): x is string => !!x)
      const uris = recs.map((r) => r.uri).filter((x): x is string => !!x)
      setResult({
        uid: t.uid, type: t.type, texts, uris,
        note: recs.length ? undefined : 'Tag is empty or carries no NDEF message.',
      })
      for (const uri of uris) {
        const key = `${t.uid}|${uri}`
        if (!seen.current.has(key)) {
          seen.current.add(key)
          setPendingUrl({ uri, key })
          break
        }
      }
    } catch (e) {
      if (!silent) set({ error: (e as Error).message })
    } finally {
      if (!silent) set({ busy: false })
    }
  }

  useEffect(() => {
    if (!auto || !connected) return
    const id = setInterval(() => {
      if (!pendingUrl) void readTag(true)
    }, 2000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, connected, pendingUrl])

  const allowUrl = async () => {
    if (!pendingUrl) return
    const uri = pendingUrl.uri
    setPendingUrl(null)
    try {
      await api().openUrl(uri)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Tap to read</CardTitle>
          <CardDescription>Text shows inline · links always ask permission first, once per tag.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="ink" onClick={() => readTag(false)} disabled={!connected} loading={busy}>
              <ScanLine className="size-4" /> Scan tag
            </Button>
            <Button variant={auto ? 'destructive' : 'secondary'} onClick={() => setAuto(!auto)} disabled={!connected}>
              {auto ? 'Stop auto-scan' : 'Auto-scan'}
            </Button>
          </div>
          {!connected && <p className="mt-3 text-sm text-muted-foreground">Connect first (or use the Mock device to preview).</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>{result.type ?? 'Tag'}</CardTitle>
            <CardDescription>Card ID {result.uid ?? '?'}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              {result.texts.map((t, i) => (
                <div key={`t${i}`} className="rounded-md border bg-surface px-4 py-3">
                  <p className="eyebrow text-muted-foreground">text record {result.texts.length > 1 ? i + 1 : ''}</p>
                  <p className="mt-1.5 text-lg">{t}</p>
                </div>
              ))}
              {result.uris.map((u, i) => (
                <div key={`u${i}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-surface px-4 py-3">
                  <div className="min-w-0">
                    <p className="eyebrow text-muted-foreground">link record {result.uris.length > 1 ? i + 1 : ''}</p>
                    <p className="mt-1.5 font-mono text-sm break-all text-brand">{u}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => {
                    const key = `${result.uid}|${u}`
                    seen.current.add(key)
                    setPendingUrl({ uri: u, key })
                  }}>
                    <ExternalLink className="size-4" /> Open…
                  </Button>
                </div>
              ))}
              {result.note && <p className="text-sm text-muted-foreground">{result.note}</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {pendingUrl && (
        <UrlPermissionModal uri={pendingUrl.uri} onAllow={allowUrl} onDeny={() => setPendingUrl(null)} />
      )}
    </div>
  )
}

function ConsoleTab() {  const logs = useStore((s) => s.logs)
  const clearLogs = useStore((s) => s.clearLogs)
  const connected = useStore((s) => s.connected)
  const set = useStore((s) => s.set)
  const busy = useStore((s) => s.busy)
  const [cmd, setCmd] = useState('02')
  const [out, setOut] = useState('')

  const send = async () => {
    set({ busy: true, error: null })
    try {
      const r = await api().raw(cmd, 2000)
      setOut(`TX ${r.tx}\nRX ${r.rx}`)
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Raw command</CardTitle>
          <CardDescription>Type a command as hex bytes and send it to the reader.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="02" className="max-w-md" />
            <Button variant="ink" onClick={send} disabled={!connected} loading={busy}>Send</Button>
          </div>
          {out && <pre className="mt-3 rounded-md border bg-surface p-3 font-mono text-xs whitespace-pre-wrap">{out}</pre>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Conversation log</CardTitle>
          <CardDescription>Everything sent and received · newest last · keeps the most recent 500.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex justify-end">
            <Button variant="ghost" size="sm" onClick={clearLogs}><Trash2 className="size-4" /> Clear</Button>
          </div>
          <div className="max-h-96 overflow-auto rounded-md border bg-surface">
            {logs.length === 0 && <p className="p-4 font-mono text-xs text-muted-foreground">— nothing here yet —</p>}
            {logs.map((l) => (
              <div key={l.id} className="grid grid-cols-[64px_1fr] gap-2 border-b px-3 py-1.5 font-mono text-xs last:border-0">
                <span className={l.dir === 'tx' ? 'text-brand' : l.dir === 'rx' ? 'text-success' : l.dir === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                  {l.dir.toUpperCase()}
                </span>
                <span>
                  <span className="text-foreground">{l.label}</span>
                  {l.hex && <span className="block text-muted-foreground">{l.hex}</span>}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default function App() {
  const tab = useStore((s) => s.tab)
  const set = useStore((s) => s.set)
  const dark = useStore((s) => s.dark)
  const error = useStore((s) => s.error)
  usePn532Events()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light')
    } catch { /* noop */ }
  }, [dark])
  useEffect(() => {
    try {
      set({ dark: localStorage.getItem('theme') === 'dark' })
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-md bg-ink text-ink-foreground"><Nfc className="size-5" /></span>
            <div>
              <p className="heading text-lg leading-none">PN532 Studio</p>
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">USB reader console</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant={tab === 'reader' ? 'secondary' : 'ghost'} size="sm" onClick={() => set({ tab: 'reader' })}><Nfc className="size-4" /> Reader</Button>
            <Button variant={tab === 'scan' ? 'secondary' : 'ghost'} size="sm" onClick={() => set({ tab: 'scan' })}><ScanLine className="size-4" /> Scan</Button>
            <Button variant={tab === 'tags' ? 'secondary' : 'ghost'} size="sm" onClick={() => set({ tab: 'tags' })}><Tags className="size-4" /> Tags</Button>
            <Button variant={tab === 'console' ? 'secondary' : 'ghost'} size="sm" onClick={() => set({ tab: 'console' })}><TerminalSquare className="size-4" /> Console</Button>
            <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={() => set({ dark: !dark })}>
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>
        </div>
      </header>

      <PageContainer>
        <PageHeader
          title={tab === 'reader' ? 'Reader dashboard' : tab === 'scan' ? 'Scan & view' : tab === 'tags' ? 'Tag read / write' : 'APDU console'}
          desc={
            tab === 'reader'
              ? 'Check your reader and look for nearby cards.'
              : tab === 'scan'
                ? 'Tap a tag to display its text or preview its link. Links never open without your permission.'
              : tab === 'tags'
                ? 'Read and write cards, see what is stored on them, and save new messages.'
                : 'Send raw commands and watch the conversation.'
          }
        />
        {error && (
          <div className="mb-4 rounded-md border bg-destructive/10 px-4 py-2.5 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}
        <div className="grid gap-4">
          <ConnectionBar />
          {tab === 'reader' && <ReaderTab />}
          {tab === 'scan' && <ScanTab />}
          {tab === 'tags' && <TagsTab />}
          {tab === 'console' && <ConsoleTab />}
        </div>
      </PageContainer>
    </div>
  )
}
