// Calls over a MessagePort, both ways, each with a time limit. public/plugin-host.js speaks the same
// messages: { id, m, a } asks, { re, ok, v | e } answers.

import { CALL_TIMEOUT_MS } from './validate'

export type Handler = (method: string, args: unknown[]) => unknown | Promise<unknown>

export interface Rpc {
  call<T = unknown>(method: string, args?: unknown[], timeoutMs?: number): Promise<T>
  close(): void
}

/** `onTimeout` runs after a call passes its limit: the other side may be stuck, so the caller can end it. */
export function connect(port: MessagePort, handle: Handler, timeoutMs = CALL_TIMEOUT_MS, onTimeout?: () => void): Rpc {
  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  port.onmessage = async (e: MessageEvent) => {
    const d = e.data
    if (!d || typeof d !== 'object') return
    if (typeof d.re === 'number') {
      const p = pending.get(d.re)
      if (!p) return
      pending.delete(d.re)
      clearTimeout(p.timer)
      if (d.ok) p.resolve(d.v)
      else p.reject(new Error(typeof d.e === 'string' ? d.e.slice(0, 500) : 'The plugin failed.'))
      return
    }
    if (typeof d.id !== 'number' || typeof d.m !== 'string') return
    try {
      const v = await handle(d.m, Array.isArray(d.a) ? d.a : [])
      port.postMessage({ re: d.id, ok: true, v })
    } catch (err) {
      port.postMessage({ re: d.id, ok: false, e: (err as Error)?.message ?? String(err) })
    }
  }

  return {
    call<T>(method: string, args: unknown[] = [], ms = timeoutMs): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = ++seq
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The plugin took longer than ${Math.round(ms / 1000)} seconds.`))
          onTimeout?.()
        }, ms)
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        port.postMessage({ id, m: method, a: args })
      })
    },
    close() {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('The plugin stopped.')) }
      pending.clear()
      port.onmessage = null
      port.close()
    },
  }
}
