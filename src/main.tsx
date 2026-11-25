import { render } from 'preact'
import { App } from './app'
import './styles.css'

render(<App />, document.getElementById('app')!)

if ('serviceWorker' in navigator && import.meta.env.PROD && !('__TAURI_INTERNALS__' in window)) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
