import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(fileURLToPath(import.meta.url))

// Web demo build for Vercel: same React UI as the desktop app, backed by
// Web Serial (real hardware in Chrome/Edge) or the built-in mock device.
export default defineConfig({
  root: resolve(rootDir, 'src/web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(rootDir, 'src/renderer'),
      '@shared': resolve(rootDir, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(rootDir, 'dist-web'),
    emptyOutDir: true,
  },
})
