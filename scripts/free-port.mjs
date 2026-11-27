// A port nothing on this machine is listening on, so test runs in parallel worktrees never reach
// each other's servers (two runs on one fixed port meant one tested the other's build).
import { createServer } from 'node:net'

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}
