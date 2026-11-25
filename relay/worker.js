// Flick sync relay. It introduces a sync group's devices to each other and forwards their
// messages. Every message is sealed on the device with the group key, so the relay sees only
// a room id (a hash of the group secret) and ciphertext. It stores nothing.

import { DurableObject } from 'cloudflare:workers'

const MAX_PEERS = 16
const MAX_MSG = 256 * 1024
const MAX_PER_MIN = 600

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
  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_PEERS) return new Response('Room full\n', { status: 429 })
    const [client, server] = Object.values(new WebSocketPair())
    // Hibernation: the room costs nothing while devices sit connected and quiet.
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ win: Date.now(), n: 0 })
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return ws.close(1009, 'Message too big')
    const a = ws.deserializeAttachment() ?? { win: Date.now(), n: 0 }
    const now = Date.now()
    if (now - a.win > 60_000) { a.win = now; a.n = 0 }
    if (++a.n > MAX_PER_MIN) return ws.close(1008, 'Too many messages')
    ws.serializeAttachment(a)
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) try { peer.send(msg) } catch { /* closing */ }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye') } catch { /* already closed */ }
  }
}
