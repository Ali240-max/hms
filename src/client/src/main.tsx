import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import App from './App'
import { PrefsProvider } from './lib/prefs'
import { ToastProvider } from './lib/toast'
import './index.css'

/**
 * `reducedMotion="user"` strips every animation for anyone who has asked their
 * computer for less movement.
 *
 * In a hospital that is an accessibility requirement rather than a courtesy:
 * vestibular disorders and migraine are common, and a member of staff who
 * cannot look at a moving screen still has to do their shift.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <PrefsProvider><ToastProvider><App /></ToastProvider></PrefsProvider>
    </MotionConfig>
  </React.StrictMode>
)
