import { defineConfig, type Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

// Plugins shipped with Flick: plugins/<name>/plugin.js serves as /plugins/<name>.js, theme.json as
// /plugins/<name>.json, next to index.json (the official list) and flick-plugin.d.ts.
function pluginFiles(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of ['index.json', 'flick-plugin.d.ts']) out.set(`/plugins/${f}`, `plugins/${f}`)
  for (const d of readdirSync('plugins', { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (existsSync(`plugins/${d.name}/plugin.js`)) out.set(`/plugins/${d.name}.js`, `plugins/${d.name}/plugin.js`)
    if (existsSync(`plugins/${d.name}/theme.json`)) out.set(`/plugins/${d.name}.json`, `plugins/${d.name}/theme.json`)
  }
  return out
}

function bundledPlugins(): Plugin {
  let outDir = 'dist'
  const type = (f: string) => (f.endsWith('.json') ? 'application/json' : 'text/javascript; charset=utf-8')
  return {
    name: 'flick-plugins',
    configResolved(c) { outDir = c.build.outDir },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = pluginFiles().get((req.url ?? '').split('?')[0])
        if (!file) return next()
        res.setHeader('content-type', type(file))
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      mkdirSync(join(outDir, 'plugins'), { recursive: true })
      for (const [url, file] of pluginFiles()) cpSync(file, join(outDir, url))
    },
  }
}

export default defineConfig({
  plugins: [preact(), pdfjsData(), bundledPlugins()],
  define: { 'import.meta.env.VITE_PDFJS_BASE': JSON.stringify(PDFJS_BASE) },
  clearScreen: false,
  server: { port: 5178, strictPort: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 600 },
  // Agent worktrees under .claude/ hold other branches' tests.
  test: { environment: 'node', exclude: ['**/node_modules/**', '.claude/**'], globalSetup: ['tests/media-setup.mjs'] },
})
