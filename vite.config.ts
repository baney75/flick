import { defineConfig, type Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

// pdf.js reads character maps, standard fonts, color profiles and image decoders from separate files.
// They ship under a versioned /assets path, so the service worker caches them once and books open offline.
const PDFJS = 'node_modules/pdfjs-dist'
const PDFJS_VERSION = JSON.parse(readFileSync(`${PDFJS}/package.json`, 'utf8')).version as string
const PDFJS_BASE = `/assets/pdfjs-${PDFJS_VERSION}/`
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

function pdfjsData(): Plugin {
  let outDir = 'dist'
  return {
    name: 'flick-pdfjs-data',
    configResolved(c) { outDir = c.build.outDir },
    configureServer(server) {
      server.middlewares.use(PDFJS_BASE, (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0])).replace(/^([/\\])+/, '')
        const file = join(PDFJS, rel)
        if (!PDFJS_DIRS.includes(rel.split(/[/\\]/)[0]) || !existsSync(file) || !statSync(file).isFile()) return next()
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      for (const d of PDFJS_DIRS) cpSync(`${PDFJS}/${d}`, join(outDir, PDFJS_BASE, d), { recursive: true })
    },
  }
}

export default defineConfig({
  plugins: [preact(), pdfjsData()],
  define: { 'import.meta.env.VITE_PDFJS_BASE': JSON.stringify(PDFJS_BASE) },
  clearScreen: false,
  server: { port: 5178, strictPort: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 600 },
  // Agent worktrees under .claude/ hold other branches' tests.
  test: { environment: 'node', exclude: ['**/node_modules/**', '.claude/**'] },
})
