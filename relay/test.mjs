// Relay check: runs the Worker under `wrangler dev`, or against RELAY_URL when set,
// and checks forwarding, room isolation, the size cap and bad paths.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { freePort } from '../scripts/free-port.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

// The wrangler pinned in package.json, never whatever npx would fetch.
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js')

// Free ports, so a run in another worktree is never the one answering (see scripts/free-port.mjs).
const PORT = await freePort(), INSPECTOR = await freePort()
let base = process.env.RELAY_URL
let dev
if (!base) {
  base = `http://127.0.0.1:${PORT}`
  dev = spawn(process.execPath, [WRANGLER, 'dev', '--port', String(PORT), '--inspector-port', String(INSPECTOR), '--persist-to', mkdtempSync(join(tmpdir(), 'flick-relay-')), '--ip', '127.0.0.1', '--var', 'IDLE_MS:2000'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
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

  const wide = await client(room('c'))
  wide.s.send('\u20ac'.repeat(100_000)) // 100,000 characters, 300,000 bytes
  check('the size cap counts bytes, not characters', (await Promise.race([wide.closed, wait(3000).then(() => 0)])) === 1009)

  const pong = await client(room('d'))
  pong.s.send('ping')
  await wait(400)
  check('the relay answers ping with pong', pong.got.includes('pong'))
  pong.s.close()

  const full = await Promise.all(Array.from({ length: 16 }, () => client(room('e'))))
  const extra = await client(room('e')).then((x) => { x.s.close(); return 'opened' }, () => 'refused')
  check('a 17th device in an active room is refused', extra === 'refused')
  if (dev) {
    // Locally the idle limit is 2 seconds: after that, a newcomer takes the quietest device's place.
    await wait(2500)
    const late = await client(room('e')).then((x) => x, () => null)
    late?.s.send('after')
    await wait(500)
    const heard = full.filter((x) => x.got.includes('after')).length
    check(`a full room drops a device that went quiet (${heard} of 16 still hear the room)`, !!late && heard === 15)
    late?.s.close()
  }
  for (const x of full) x.s.close()

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
