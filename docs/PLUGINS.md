# Flick plugins, API version 1

Flick's core is a player, a library and a reader. Every outside source (Stremio, the Internet Archive,
YouTube, anything else) and every look (themes) is a plugin. Anyone, or their AI agent, can write one
as a single JavaScript file with no build step.

## Two kinds

| Kind | File | Runs code | What it can do |
| --- | --- | --- | --- |
| Source plugin | one ES module, `plugin.js` | yes, in a sandbox | catalogs, search, title pages, streams, library rows, settings, sign-in |
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
  `{ "api": 1, "plugins": [{ "url", "name", "kind": "source" | "theme", "description" }] }`.
- The list of installed plugins and their non-secret settings sync between paired devices, along with
  on or off and the chosen theme. Plugins installed from a file stay on that device. Fields
  marked `secret` (passwords, tokens) never leave the device.
- Flick never installs a source on the user's behalf. One exception: on upgrade, a user who already
  used the built-in Stremio section (signed in, or added addons) gets the Stremio plugin installed
  with their data moved over, so nothing they had disappears.

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
- `Sub`: `{ url, lang, label? }`, `url` is `http:` or `https:` (SRT or VTT).
- Strings are trimmed to 2,000 characters, lists to 500 items, `items` to 200 per call.

### ctx

- `ctx.fetch(url, init?)`: like `fetch`, returns `{ status, ok, headers, text(), json() }`. `init`
  takes `method`, `headers` and a string `body`. On the website it is the sandbox's own fetch, so the
  server must allow CORS (most public APIs do). In the desktop app it goes through the app with no
  CORS limit, only to `hosts`, and every redirect is checked against `hosts` too. The host list Flick
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
- `ctx.tools.<name>(...)`: desktop tools the plugin listed in `tools`. Version 1 reserves one name:
  `ytdlp` with `search(query, limit)`, `resolve(url)` (returns a `flick-tool:` stream URL the player
  plays) and `download(url)` (saves for offline). This Flick does not ship the tool yet: a manifest may
  list it, and calls fail with a plain message until a later version adds it.
- `ctx.log(...)`: shows in Settings > Plugins > this plugin > Log.

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

- `skills/flick-plugin/SKILL.md` and `skills/flick-theme/SKILL.md` teach an agent to write, check and
  publish one.
- `plugins/template/plugin.js` is a working starting point.
- `npm run plugin:check -- <file or URL>` loads a plugin the way Flick does, validates the manifest,
  calls every catalog, a search, one `meta` and its `streams` against the real source, and prints
  PASS or FAIL for each. `npm run plugin:check -- theme.json` checks a theme, contrast included.
  Flags: `--search <term>` (default `the`), `--set key=value` for a setting. It also fails when an
  entry would be dropped by the validator, or when `ctx.fetch` goes to a host missing from `hosts`.
  It runs the plugin in Node, outside the sandbox, so check only code you are willing to run.
- Settings > Plugins > Make your own copies a prompt for any AI agent that points at this file.
