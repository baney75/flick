# Flick plugins, API version 1

Flick's core is a player, a library and a reader. Every outside source (Stremio, the Internet Archive,
YouTube, anything else) and every look (themes) is a plugin. Anyone, or their AI agent, can write one
as a single JavaScript file with no build step.

## Three kinds

| Kind | File | Runs code | What it can do |
| --- | --- | --- | --- |
| Source plugin | one ES module, `plugin.js` | yes, in a sandbox | catalogs, search, title pages, streams, library rows, settings, sign-in |
| Service plugin | one ES module, `plugin.js`, with `kind: 'service'` | yes, in a sandbox | a debrid service: checks a key, says which torrents it has, turns a torrent into an https link |
| Theme | one JSON file, `theme.json` | no | colors, radius, font for light and dark |

## Install

- From a URL (Settings > Plugins > Add by URL), from the official list (`/plugins/index.json` on the
  site), from a file, or from a setup link (`"plugins": ["https://.../plugin.js"]`).
- Before install, Flick shows a review sheet: name, author, version, what it reaches (`hosts`), which
  desktop tools it uses (`tools`), and "Not from Flick" for anything outside the official list. Nothing
  installs without a tap.
- Installed plugin code is stored on the device (IndexedDB, with its SHA-256, checked again before each
  start). On launch Flick checks each plugin URL once a day. New code that asks for no host or tool it
  did not already have updates quietly (dropping one is fine). New permissions wait for a tap.
- Plugins that ship with Flick live at `/plugins/<name>.js` (from `plugins/<name>/plugin.js` in the
  repo) and themes at `/plugins/<name>.json`. The official list, `/plugins/index.json`, is
  `{ "api": 1, "plugins": [{ "url", "name", "kind": "source" | "service" | "theme", "description" }] }`.
- The list of installed plugins and their non-secret settings sync between paired devices, along with
  on or off and the chosen theme. Plugins installed from a file stay on that device. Fields
  marked `secret` (passwords, tokens) never leave the device. Another device installs a synced
  plugin only when its code is what was reviewed, or asks for no host or tool beyond it; otherwise
  it says so and waits for the user to add it there and review it.
- Flick never installs a source on the user's behalf. One exception: on upgrade, a user who already
  used the built-in Stremio section (signed in, added addons, watched something from it, or synced
  addons from another device) gets the Stremio plugin installed on first launch, with the sign-in key
  and addons moved into the plugin and that progress pointed at it, so nothing they had disappears.
  Everyone else gets no Stremio. Old setup links with `stremioAddons` show the Stremio plugin in the
  review and install it only on Connect all.

## Sandbox

Each source plugin runs in its own sandboxed iframe (`/plugin-host.html`, `sandbox="allow-scripts"`,
no `allow-same-origin`), so it has an opaque origin. It cannot read Flick's storage, the sync key,
server tokens, other plugins or the page. It talks to Flick only through `ctx` (a MessageChannel RPC).
Every call has a 20 second timeout and every result is validated against the shapes below. One bad
entry in a list (a meta, a stream) is skipped; a result that is wrong as a whole is dropped. Either
way a note goes to the plugin's log in Settings > Plugins.

The host page has its own Content-Security-Policy: scripts only from Flick and the plugin's own
`blob:`/`data:` module (so a plugin is one file and cannot `import` code from the web), network
`connect-src *`.

## A source plugin

```js
// plugin.js
/** @type {import('https://flick-player.pages.dev/plugins/flick-plugin').Plugin} */
export default {
  api: 1,
  id: 'org.archive',            // reverse-DNS style, lowercase, unique
  name: 'Internet Archive',
  version: '1.0.0',
  author: 'Flick',
  description: 'Public domain films, audiobooks and books from archive.org.',
  icon: 'https://archive.org/favicon.ico',   // https URL or data: URI, optional
  hosts: ['archive.org', '*.archive.org'],   // what ctx.fetch may reach on desktop, see ctx below
  tools: [],                                 // desktop tools, see below
  platforms: ['web', 'desktop', 'mobile'],   // where it works; default all
  settings: [                                // optional form in Settings > Plugins
    { key: 'lang', label: 'Language', type: 'select', options: ['en', 'any'], default: 'en' },
  ],
  actions: [                                 // optional buttons in Settings > Plugins, each with a form
    { id: 'signin', label: 'Sign in', fields: [
      { key: 'email', label: 'Email' },
      { key: 'password', label: 'Password', type: 'password' },   // password fields are secret
    ] },
  ],
  catalogs: [                                // rows on the plugin's page; one may be searchable
    { id: 'films', name: 'Feature films', type: 'movie' },
    { id: 'search', name: 'Search', type: 'movie', search: true },
  ],

  async catalog(ctx, { id, type, search, skip }) { return { items: [/* Meta */], more: true } },
  // optional: rows that depend on the user (their addons, their account); shown after `catalogs`
  async userCatalogs(ctx) { return [/* { id, name, type } */] },
  async meta(ctx, { type, id }) { return { /* Meta with videos */ } },
  async streams(ctx, { type, id, videoId }) { return [/* Stream */] },
  // optional:
  async subtitles(ctx, { type, id, videoId }) { return [/* Sub */] },            // extra subtitles for any stream
  async library(ctx) { return [/* Meta, may carry progress */] },
  async action(ctx, id, values) { return { ok: true, message: 'Signed in' } },  // an `actions` button was tapped
  async progress(ctx, { type, id, videoId, pos, dur }) {},                      // play position, to sync back
}
```

### Settings and actions

A field is `{ key, label, type?, options?, default?, secret?, help? }` with `type` one of `text`
(default), `password`, `select` (with `options`), `toggle` or `list` (a list of strings, one per
line). `secret: true` keeps the value on the device: it never syncs and never goes in a setup link.
`password` fields are always secret. Setting values reach the plugin as `ctx.settings`. Action field
values go only to that one `action()` call and are not saved; keep what you need (a token) with
`ctx.store`.

### Shapes

- `type`: `movie`, `series`, `video`, `channel`, `audio`, `audiobook`, `book`.
- `Meta`: `{ id, type, name, poster?, posterShape? ('poster'|'square'|'landscape'), background?,
  description?, year?, genres?, runtime?, videos?: Video[], progress?: { pos, dur, at, videoId? } }`.
  `id` is the plugin's own id, at most 512 characters.
- `Video` (an episode, part or chapter): `{ id, title, season?, episode?, released?, thumbnail?, overview? }`.
- `Stream`: `{ url, title?, quality?, kind? ('video'|'audio'|'book'), subs?: { url, lang, label? }[],
  needsDesktop?: true, external?: true, group? }`. `url` is `https:`, `http:` (desktop, or LAN), or
  `flick-tool:` (a desktop tool result). `kind: 'book'` opens a PDF in the reader. `needsDesktop`
  marks MKV, AVI and similar that the desktop app converts. `external: true` opens an `https:` link
  in the browser instead of the player (a trailer on YouTube, a site that needs its own app).
  `group` names the source a stream came from; the title page shows one filter chip per group.
  A stream the viewer can save for offline gets a Download button: one `http:` or `https:` file (not
  an `.m3u8` or `.mpd` playlist, a book or an external link), or a `flick-tool:ytdlp/` stream in the
  desktop app. On the website it shows only where the browser may fetch the file (CORS). A saved
  title plays from the file with no network and keeps its progress.
- `Sub`: `{ url, lang, label? }`, `url` is `http:` or `https:` (SRT or VTT).
- Strings are trimmed to 2,000 characters, lists to 500 items, `items` to 200 per call.

### ctx

- `ctx.fetch(url, init?)`: like `fetch`, returns `{ status, ok, headers, text(), json() }`. `init`
  takes `method`, `headers` and a string `body`. On the website it is the sandbox's own fetch, so the
  server must allow CORS (most public APIs do). In the desktop app it goes through the app with no
  CORS limit, only to `hosts`, and every redirect is checked against `hosts` too. A redirect from
  `https:` to `http:` is refused for every plugin, because it would send the request's headers in
  the clear. The host list Flick
  enforces is the one from the installed manifest; the plugin never sends it.
  - `hosts` entries: `example.com` (that host), `*.example.com` (its subdomains, not itself), or `*`
    (any public host; for plugins that reach addresses the user types, like Stremio addons). `*`
    never reaches this computer or the local network (`localhost`, `127.0.0.1`, `192.168.x.x`,
    `.local`, or a public name that resolves to one); list those by name, like `127.0.0.1`.
  - In the desktop and mobile apps, `ctx.fetch` is the only network a plugin has: its sandbox page
    allows no `fetch`, WebSocket, remote image or media of its own, so `hosts` is what it can reach.
  - On the website, the sandbox's own `fetch` works with the browser's CORS and private network
    rules, and `hosts` is not enforced there. The review sheet says so on the website.
- `ctx.store.get(key)` / `ctx.store.set(key, value)`: this plugin's own saved data (JSON, 1 MB total).
- `ctx.settings`: current setting values.
- `ctx.platform`: `'web' | 'desktop' | 'mobile'`.
- `ctx.tools.<name>.<op>(...)`: desktop tools the plugin listed in `tools`, desktop app only. The app
  checks each call against the `tools` of the installed manifest. Version 1 has one, `ytdlp`:
  - `search(query, limit)`: YouTube search, up to 50 `Meta`s of type `video`. Each `id` is the watch
    URL; each also carries `channel` and `duration` (seconds).
  - `resolve(url)`: returns a `flick-tool:` stream URL for an `https:` page on the plugin's `hosts`.
    Flick picks the format (H.264 and AAC, up to 1080p) and plays it while yt-dlp streams it.
  - `download(url)`: a plugin cannot start a download; it fails with a plain message. The viewer saves
    a `resolve()`d stream with its Download button, and yt-dlp writes one mp4 in the same format.
  Flick downloads the official yt-dlp release on first use, checks it against the release's
  SHA2-256SUMS, and updates it once a day. While that first download runs, calls fail with how far
  it got. A yt-dlp on PATH is used only when Flick's own fails. Playing needs ffmpeg.
- `ctx.log(...)`: shows in Settings > Plugins > this plugin > Log.

## A service plugin

A debrid service (TorBox, Real-Debrid and the like) fetches a torrent on its own servers and hands back
an https link, so the torrent plays with no peer-to-peer traffic from this computer. A service plugin
has no catalogs; it exports `kind: 'service'`, `provides: ['debrid']` and three functions:

```js
export default {
  api: 1, kind: 'service', provides: ['debrid'],
  id: 'app.example.debrid', name: 'Example Debrid', version: '1.0.0',
  hosts: ['api.example.app', '*.cdn.example.net'],   // named hosts only, never `*`
  debridHosts: ['*.cdn.example.net'],                // where its download links live; each also in hosts
  settings: [{ key: 'apiKey', label: 'API key', type: 'password', help: 'Find it at https://example.app/settings.' }],

  async account(ctx) { return { ok: true, name: 'Example', plan: 'Pro', expires: '2027-03-01' } }, // or { ok: false, message }
  async cached(ctx, hashes) { return [/* the asked infoHashes it already has */] },
  async resolve(ctx, { infoHash, fileIdx, name }) { return { url: 'https://x.cdn.example.net/file.mkv' } },
}
```

The user sets a service up in Settings > Streaming services, not Settings > Plugins: Flick runs
`account()` with the key first and saves the key only when it answers `ok: true`. The key is the
service's first `password` setting.

- `account(ctx)` checks the key in `ctx.settings`: `{ ok: true, name, plan?, expires? }`, or
  `{ ok: false, message }` with the service's own words.
- `cached(ctx, hashes)` gets at most 100 lowercase infoHashes and returns the ones already on the
  service. Flick keeps only hashes it asked about. A service with no way to tell returns `[]`.
- `resolve(ctx, torrent)` gets `{ infoHash, fileIdx?, name? }` and returns `{ url }`, `{ wait: { pct?,
  message } }` while the service fetches a torrent it does not have yet, or `{ error }`. Flick asks
  again every 3 seconds while it gets `wait`, for at most 10 minutes. A `url` that is not https, or not
  on the plugin's `hosts`, is refused.
- Flick sends a service only the infoHash, file index and file name: never the library, other titles
  or a Stremio account. It calls a service only for a torrent stream and only in the desktop app.
- The VPN: by default Flick calls a service only while a VPN is on and hides this computer, and a
  stream whose link is on a service's `debridHosts` is held to the same rule. A service whose playback
  is only an https download from its own servers (no peer sees the user) may say `vpnOptional: true`;
  it then plays with or without a VPN, and Flick shows which, unless the user turns on "Require a VPN
  for debrid services too". An update that drops a debrid host or turns on `vpnOptional` waits for a tap.
- The key is a `password` field, so it is secret: it stays on the device, never syncs and never goes
  in a setup link. A service plugin cannot use desktop tools.

## A theme

```json
{
  "flick": "theme", "api": 1, "id": "com.example.forest", "name": "Forest", "version": "1.0.0",
  "author": "Example",
  "light": { "bg": "#f4f1ea", "surface": "#ffffff", "fg": "#1d2420", "dim": "#5c675f", "line": "#dcd6c8", "accent": "#2f7a4f" },
  "dark":  { "bg": "#101512", "surface": "#18201b", "fg": "#eef2ec", "dim": "#9aa79d", "line": "#26302a", "accent": "#5cc488" },
  "radius": 12,
  "font": "Inter"
}
```

Install a theme like a plugin, then pick it in Settings > Appearance > Colors. Light and dark still
follow Settings > Appearance > Mode.

Only the listed tokens, `radius` (0 to 24) and `font` are read. Colors must be `#rgb`, `#rrggbb` or
`#rrggbbaa`. `font` is a family name (letters, digits, spaces, `-`, `_`). Flick does not download
fonts, so use a system font or one the user has installed; Flick's own font stack is the fallback.
Flick checks that `fg` on `bg` and on `surface` reaches 4.5:1 contrast (a translucent color is laid
over black in dark mode and white in light mode) and refuses a theme that doesn't. The other
variables Flick uses (hover surfaces, the faint text color, text on the accent) are mixed from these
tokens.

## For agents

- `skills/flick-plugin/SKILL.md` (sources and services) and `skills/flick-theme/SKILL.md` teach an agent to write, check and
  publish one.
- `plugins/template/plugin.js` is a working starting point.
- `npm run plugin:check -- <file or URL>` loads a plugin the way Flick does, validates the manifest,
  calls every catalog, a search, one `meta` and its `streams` against the real source, and prints
  PASS or FAIL for each. `npm run plugin:check -- theme.json` checks a theme, contrast included.
  Flags: `--search <term>` (default `the`), `--set key=value` for a setting. It also fails when an
  entry would be dropped by the validator, or when `ctx.fetch` goes to a host missing from `hosts`.
  It runs the plugin in Node, outside the sandbox, so check only code you are willing to run.
  Desktop tools are stubs there: the manifest must list the tool, `ytdlp.search` answers with
  recorded results and `ytdlp.resolve` checks the URL against `hosts`. For a service plugin it calls
  `account()` with `--set apiKey=<key>`, and with `--hash <infoHash>` also `cached()` and one `resolve()`.
- Settings > Plugins > Make your own copies a prompt for any AI agent that points at this file.
