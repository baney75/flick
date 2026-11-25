import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  clearScreen: false,
  server: { port: 5178, strictPort: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 600 },
  test: { environment: 'node' },
})
