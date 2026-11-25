// Relay check: runs the Worker under `wrangler dev`, or against RELAY_URL when set,
// and checks forwarding, room isolation, the size cap and bad paths.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PORT = 8789
let base = process.env.RELAY_URL
let dev
if (!base) {
  base = `http://127.0.0.1:${PORT}`
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('wrangler dev did not start')), 60_000)
    const on = (b) => { if (/Ready on/.test(String(b))) { clearTimeout(t); ok() } }
    dev.stdout.on('data', on); dev.stderr.on('data', on)
  })
}
const ws = base.replace(/^http/, 'ws')
let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }

function client(room) {
  const s = new WebSocket(`${ws}/room/${room}`)
  const got = []
  s.addEventListener('message', (e) => got.push(String(e.data)))
  const closed = new Promise((ok) => s.addEventListener('close', (e) => ok(e.code)))
  return new Promise((ok, bad) => { s.addEventListener('open', () => ok({ s, got, closed })); s.addEventListener('error', bad) })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const room = (c) => c.repeat(32)

try {
  const [a, b, c] = await Promise.all([client(room('a')), client(room('a')), client(room('b'))])
  a.s.send('hello from a')
  await wait(400)
  check('a peer in the room gets the message', b.got.includes('hello from a'))
  check('the sender does not get its own message back', !a.got.length)
  check('another room hears nothing', !c.got.length)

  b.s.send('x'.repeat(300 * 1024))
  check('an oversized message closes that socket', (await Promise.race([b.closed, wait(3000).then(() => 0)])) === 1009)

  const bad = await fetch(`${base}/room/not-a-room`)
  check('a malformed room is 404', bad.status === 404)
  const plain = await fetch(`${base}/room/${room('a')}`)
  check('a plain GET to a room asks for a WebSocket', plain.status === 426)
  for (const x of [a, c]) x.s.close()
} catch (e) {
  check(`relay reachable (${e.message ?? e})`, false)
} finally {
  dev?.kill()
}
console.log(failed ? `relay: ${failed} failed` : 'relay: all checks passed')
process.exit(failed ? 1 : 0)
