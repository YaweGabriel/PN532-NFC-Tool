import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import '@/index.css'
import { installWebApi } from './pn532-web'

installWebApi()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
