import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopProvider } from './lib/desktop'
import { TooltipProvider } from './components/controls'
import { TrayPanel } from './tray/TrayPanel'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <DesktopProvider>
      <TooltipProvider><TrayPanel /></TooltipProvider>
    </DesktopProvider>
  </StrictMode>,
)
