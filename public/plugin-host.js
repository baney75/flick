// Runs inside the sandboxed plugin iframe (see plugin-host.html). Flick sends one MessagePort, then
// asks over it: load(code, platform, settings) and call(fn, args). The plugin reaches Flick only through
// ctx, which asks back over the same port. Same message format as src/lib/plugins/rpc.ts.
;(function () {
  'use strict'
  var TIMEOUT = 20000
  var port = null
  var plugin = null
  var platform = 'web'
  var settings = {}
  var seq = 0
  var pending = new Map()

  function ask(m, a) {
    return new Promise(function (resolve, reject) {
      var id = ++seq
      var timer = setTimeout(function () { pending.delete(id); reject(new Error(m + ' took longer than 20 seconds')) }, TIMEOUT)
      pending.set(id, { resolve: resolve, reject: reject, timer: timer })
      port.postMessage({ id: id, m: m, a: a })
    })
  }

  // Plain data only: functions, classes and DOM nodes never cross to Flick.
  function plain(x) { return x === undefined ? null : JSON.parse(JSON.stringify(x)) }

  function response(status, headers, body) {
    return {
      status: status,
      ok: status >= 200 && status < 300,
      headers: headers,
      text: function () { return Promise.resolve(body) },
      json: function () { return Promise.resolve().then(function () { return JSON.parse(body) }) },
    }
  }

  var ctx = {
    get platform() { return platform },
    get settings() { return settings },
    fetch: function (url, init) {
      init = init || {}
      var req = { method: init.method || 'GET', headers: init.headers || {}, body: init.body == null ? null : String(init.body) }
      if (platform !== 'web') {
        // The desktop app fetches for the plugin, with no CORS limit, only to the hosts Flick holds for it.
        return ask('fetch', [String(url), req]).then(function (r) { return response(r.status, r.headers, r.body) })
      }
      return fetch(String(url), { method: req.method, headers: req.headers, body: req.body, credentials: 'omit' }).then(function (r) {
        var h = {}
        r.headers.forEach(function (v, k) { h[k] = v })
        return r.text().then(function (t) { return response(r.status, h, t) })
      })
    },
    store: {
      get: function (key) { return ask('store.get', [String(key)]) },
      set: function (key, value) { return ask('store.set', [String(key), plain(value)]) },
    },
    log: function () {
      var parts = Array.prototype.map.call(arguments, function (x) {
        if (typeof x === 'string') return x
        try { return JSON.stringify(x) } catch (e) { return String(x) }
      })
      ask('log', [parts.join(' ').slice(0, 2000)]).catch(function () {})
    },
    tools: new Proxy({}, {
      get: function (_, name) {
        return new Proxy({}, {
          get: function (_, fn) {
            return function () { return ask('tool', [String(name), String(fn), plain(Array.prototype.slice.call(arguments))]) }
          },
        })
      },
    }),
  }

  function load(code) {
    var blob = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    return import(blob)
      .catch(function () {
        // Some web views refuse blob: modules from an opaque origin; data: works there.
        return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(code))
      })
      .finally(function () { URL.revokeObjectURL(blob) })
  }

  var handlers = {
    load: function (code, plat, sets) {
      platform = plat
      settings = Object.freeze(plain(sets || {}))
      return load(code).then(function (mod) {
        var p = mod && mod.default
        if (!p || typeof p !== 'object') throw new Error('The plugin must export a default object.')
        plugin = p
        var data = {}
        var fns = []
        Object.keys(p).forEach(function (k) {
          if (typeof p[k] === 'function') fns.push(k)
          else data[k] = p[k]
        })
        return { manifest: plain(data), fns: fns }
      })
    },
    settings: function (sets) { settings = Object.freeze(plain(sets || {})) },
    call: function (fn, args) {
      if (!plugin) throw new Error('No plugin loaded.')
      if (['userCatalogs', 'catalog', 'meta', 'streams', 'subtitles', 'library', 'action', 'titleAction', 'progress', 'addonUrls', 'extensions', 'extensionCatalog', 'inspectExtension', 'addExtension', 'removeExtension', 'account', 'cached', 'resolve'].indexOf(fn) < 0 || typeof plugin[fn] !== 'function') {
        throw new Error('The plugin has no ' + fn + '() function.')
      }
      return Promise.resolve(plugin[fn].apply(plugin, [ctx].concat(args || []))).then(plain)
    },
  }

  function onMessage(e) {
    var d = e.data
    if (!d || typeof d !== 'object') return
    if (typeof d.re === 'number') {
      var p = pending.get(d.re)
      if (!p) return
      pending.delete(d.re)
      clearTimeout(p.timer)
      if (d.ok) p.resolve(d.v)
      else p.reject(new Error(d.e))
      return
    }
    if (typeof d.id !== 'number' || !handlers.hasOwnProperty(d.m)) return
    Promise.resolve()
      .then(function () { return handlers[d.m].apply(null, d.a || []) })
      .then(function (v) { port.postMessage({ re: d.id, ok: true, v: v === undefined ? null : v }) })
      .catch(function (err) { port.postMessage({ re: d.id, ok: false, e: String((err && err.message) || err) }) })
  }

  // Take the first port Flick sends, then stop listening, so nothing else can swap it.
  function first(e) {
    if (e.source !== parent || port || !e.ports || !e.ports[0]) return
    port = e.ports[0]
    removeEventListener('message', first)
    port.onmessage = onMessage
    port.postMessage({ ready: true })
  }
  addEventListener('message', first)
})()
