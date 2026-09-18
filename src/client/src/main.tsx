import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PrefsProvider } from './lib/prefs'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrefsProvider><App /></PrefsProvider>
  </React.StrictMode>
)
