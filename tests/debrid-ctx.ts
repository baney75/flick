// A fake plugin ctx for service plugin tests: answers from recorded fixtures and records every request.
export interface Req { method: string; url: string; headers: Record<string, string>; body?: string }
export interface Reply { status: number; body: unknown }

export function fakeCtx(settings: Record<string, unknown>, route: (r: Req) => Reply) {
  const requests: Req[] = []
  const store = new Map<string, unknown>()
  const ctx = {
    platform: 'desktop',
    settings,
    requests,
    async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
      const req: Req = { method: init.method ?? 'GET', url, headers: init.headers ?? {}, body: init.body }
      requests.push(req)
      const r = route(req)
      const text = JSON.stringify(r.body)
      return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: async () => text, json: async () => JSON.parse(text) }
    },
    store: {
      async get(k: string) { return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null },
      async set(k: string, v: unknown) { if (v == null) store.delete(k); else store.set(k, JSON.parse(JSON.stringify(v))) },
    },
    tools: {},
    log() {},
  }
  return ctx
}

/** The functions and data of a plugin module, the way Flick's sandbox reads them. */
export function split(p: Record<string, unknown>) {
  const data: Record<string, unknown> = {}, fns: string[] = []
  for (const [k, v] of Object.entries(p)) (typeof v === 'function' ? fns.push(k) : (data[k] = v))
  return { data: JSON.parse(JSON.stringify(data)), fns }
}
