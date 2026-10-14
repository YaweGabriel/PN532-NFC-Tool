import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { Pn532Service } from './pn532-service.js'

let win: BrowserWindow | null = null
const pn532 = new Pn532Service()

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#fafafa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.webContents.setWindowOpenHandler((d) => {
    void shell.openExternal(d.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc() {
  ipcMain.handle('ports:list', () => pn532.listPorts())
  ipcMain.handle('adapter:echo', (_e, port: string, baud = 115200) => pn532.echoTest(port, baud))
  ipcMain.handle('pn532:connect', (_e, port: string, baud = 115200) => pn532.connect(port, baud))
  ipcMain.handle('pn532:disconnect', () => pn532.disconnect())
  ipcMain.handle('pn532:status', () => pn532.status())
  ipcMain.handle('pn532:firmware', () => pn532.getFirmwareVersion())
  ipcMain.handle('pn532:sam-config', () => pn532.samConfiguration())
  ipcMain.handle('pn532:poll-once', (_e, timeoutMs = 1500) => pn532.pollOnce(timeoutMs))
  ipcMain.handle('pn532:poll-start', (_e, intervalMs = 1200) => {
    pn532.startPolling(intervalMs, (target) => {
      win?.webContents.send('pn532:target', target)
    })
    return { ok: true }
  })
  ipcMain.handle('pn532:poll-stop', () => pn532.stopPolling())
  ipcMain.handle('pn532:mifare-read', (_e, args: { block: number; key: string; keyType: 'A' | 'B' }) =>
    pn532.mifareReadBlock(args.block, args.key, args.keyType),
  )
  ipcMain.handle(
    'pn532:mifare-write',
    (_e, args: { block: number; key: string; keyType: 'A' | 'B'; dataHex: string }) =>
      pn532.mifareWriteBlock(args.block, args.key, args.keyType, args.dataHex),
  )
  ipcMain.handle('pn532:ntag-read', (_e, args: { page: number }) => pn532.ntagReadPage(args.page))
  ipcMain.handle('pn532:ntag-write', (_e, args: { page: number; dataHex: string }) =>
    pn532.ntagWritePage(args.page, args.dataHex),
  )
  ipcMain.handle('pn532:raw', (_e, args: { commandHex: string; timeoutMs?: number }) =>
    pn532.rawCommand(args.commandHex, args.timeoutMs ?? 2000),
  )
  pn532.onLog((entry) => win?.webContents.send('pn532:log', entry))
}

void app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void pn532.disconnect()
  if (process.platform !== 'darwin') app.quit()
})
