// Flick sync relay. It introduces a sync group's devices to each other and forwards their
// messages. Every message is sealed on the device with the group key, so the relay sees only
// a room id (a hash of the group secret) and ciphertext. It stores nothing.

import { DurableObject } from 'cloudflare:workers'

const MAX_PEERS = 16
const MAX_MSG = 256 * 1024
const MAX_PER_MIN = 600
// A device that has said nothing for this long, not even a ping, may be gone without a close
// (a laptop asleep, a phone that changed networks). A full room makes room by dropping it.
const IDLE_MS = 90_000
const bytes = new TextEncoder()

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const m = url.pathname.match(/^\/room\/([0-9a-f]{32})$/)
    if (!m) return new Response('Flick sync relay\n', { status: url.pathname === '/' ? 200 : 404 })
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket\n', { status: 426 })
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req)
  },
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.idleMs = Number(env.IDLE_MS) || IDLE_MS // the local test shortens it
    // Devices send "ping" to keep their place; the relay answers without waking up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  // A socket the relay closed may never finish closing if its device is gone, so it stops counting at once.
  live() {
    return this.ctx.getWebSockets().filter((w) => !w.deserializeAttachment()?.gone)
  }

  lastHeard(ws) {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0
    return Math.max(ws.deserializeAttachment()?.seen ?? 0, pinged)
  }

  async fetch() {
    const peers = this.live()
    if (peers.length >= MAX_PEERS) {
      const quiet = peers.reduce((a, b) => (this.lastHeard(b) < this.lastHeard(a) ? b : a))
      if (Date.now() - this.lastHeard(quiet) < this.idleMs) return new Response('Room full\n', { status: 429 })
      quiet.serializeAttachment({ ...quiet.deserializeAttachment(), gone: true })
      try { quiet.close(4001, 'Idle') } catch { /* already gone */ }
    }
    const [client, server] = Object.values(new WebSocketPair())
    // Hibernation: the room costs nothing while devices sit connected and quiet.
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ win: Date.now(), n: 0, seen: Date.now() })
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws, msg) {
    // The cap is in bytes: a string's length counts UTF-16 units, and a character can take three bytes.
    if (typeof msg !== 'string' || (msg.length * 3 > MAX_MSG && bytes.encode(msg).length > MAX_MSG)) return ws.close(1009, 'Message too big')
    const a = ws.deserializeAttachment() ?? { win: Date.now(), n: 0 }
    if (a.gone) return
    const now = Date.now()
    a.seen = now
    if (now - a.win > 60_000) { a.win = now; a.n = 0 }
    if (++a.n > MAX_PER_MIN) return ws.close(1008, 'Too many messages')
    ws.serializeAttachment(a)
    for (const peer of this.live()) {
      if (peer !== ws) try { peer.send(msg) } catch { /* closing */ }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye') } catch { /* already closed */ }
  }
}
