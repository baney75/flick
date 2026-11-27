---
name: flick-plugin
description: Use when someone asks you to write, fix or publish a Flick source plugin (the single plugin.js file that adds catalogs, search, title pages and streams from a website or API to the Flick media player) or a Flick service plugin for a debrid service such as TorBox or Real-Debrid.
---

# Write a Flick source plugin

A Flick source plugin is one ES module, `plugin.js`, with no build step and no imports. Flick runs it
in a sandboxed iframe and talks to it through `ctx`. The full contract is `docs/PLUGINS.md`
(https://github.com/baney75/flick/blob/main/docs/PLUGINS.md); types are in `plugins/flick-plugin.d.ts`.

## Steps

1. Read `docs/PLUGINS.md` end to end. Shapes, `ctx` and the `hosts` rules are all there.
2. Pick the source. It needs a public API or pages you can read with `ctx.fetch`. On the website the
   server must send CORS headers (`Access-Control-Allow-Origin`); check with
   `curl -sI -H "Origin: null" <url>`. Without CORS the plugin works only in the desktop app.
3. Copy `plugins/template/plugin.js` (https://raw.githubusercontent.com/baney75/flick/main/plugins/template/plugin.js)
   to a new folder. Change `id` (reverse-DNS, lowercase, yours), `name`, `author`, `description`,
   `icon`, and set `hosts` to exactly the hosts `ctx.fetch` calls. Use `*` only when the user types
   the addresses (like addon URLs).
4. Write `catalog`, `meta` and `streams`. Use only `ctx.fetch`, `ctx.store`, `ctx.settings` and
   `ctx.log`. Return plain data in the documented shapes: every meta needs `id`, `type`, `name`;
   every stream needs a playable `https:` URL (or `http:` on the LAN), or a `torrent: { infoHash,
   fileIdx?, name?, trackers? }` in its place ("Stream" in `docs/PLUGINS.md`). Give `name`, the
   file's name inside the torrent, so a debrid service plays the right episode of a season pack.
5. Series: `meta` returns `videos` with `season`, `episode` and an `id` per episode; `streams` gets
   that id as `videoId`. Movies: `videoId` equals `id`.
6. Settings and sign-in: declare `settings` and `actions` fields. Mark tokens and passwords
   `secret: true` (or `type: 'password'`). Save a sign-in token with `ctx.store.set`, never in a setting.
7. Never add sources the user did not choose: no hidden addon lists, no scraping of pirated content.
8. A source that hosts addons of its own (like Stremio's) may export all five of `extensions`,
   `extensionCatalog`, `inspectExtension`, `addExtension` and `removeExtension` ("Addons" in
   `docs/PLUGINS.md`). Accept only `https://` and `stremio://` addresses, never save in
   `inspectExtension`, and return `settings` to change a list setting instead of writing it yourself.
9. Anything can be a library. A source with things the user keeps (subscriptions, saved recipes, a
   course list) exports `library(ctx)` returning `{ shelves, items }` ("Library" in
   `docs/PLUGINS.md`). Use a built-in `type` when one fits (`audio`, `book`, `video`); otherwise name
   your own kind (`podcast`, `recipe`). Each shelf becomes a chip in Flick's Library; each item lists
   its shelf ids in `shelves`. Set `added` when you know it, and put labeled details in `facts`.
   `plugin:check` prints each shelf with its item count.

## A service plugin (debrid)

A debrid service is `kind: 'service'` with `provides: ['debrid']` and no catalogs. Read "A service
plugin" in `docs/PLUGINS.md`, then:

1. Put the service's API doc URL in a comment at the top of the file.
2. `hosts` names the API host and the download hosts, never `*`. `debridHosts` lists the download
   hosts again.
3. One `password` setting holds the API key; its `help` names the exact page where the user finds it.
4. Write `account`, `cached` and `resolve`. If the API cannot do one of them (no cache check), say so
   in a comment and return the documented fallback (`[]`), never a guess.
5. In `resolve`, pick the file by `fileIdx` only if the API's file list keeps torrent order, else by
   the exact `name`, else the largest video holding the `episode` tag (`S01E02`, `1x02`); never the
   first file of a pack. Return the file's size as `bytes` with the `url`.
6. Check with `npm run plugin:check -- plugin.js --set apiKey=<key> --hash <infoHash>`. Tests use
   recorded responses, never a real key.

## Check

```sh
npm run plugin:check -- path/to/plugin.js
npm run plugin:check -- path/to/plugin.js --search "night" --set lang=en
```

It loads the plugin with Flick's own validator, calls every catalog, a search, one `meta` and its
`streams` against the real source, and prints PASS or FAIL per step. Fix every FAIL. It also fails
when Flick would drop an entry or when `ctx.fetch` reaches a host missing from `hosts`.
Done means it exits 0.

## Publish

The plugin installs from any `https://` URL that serves the file:

- A GitHub gist: create the gist with `plugin.js`, open it, and copy the **Raw** link
  (`https://gist.githubusercontent.com/<user>/<id>/raw/plugin.js`). Drop the commit hash from the
  path so updates reach users: Flick checks the URL once a day.
- Any https host (GitHub Pages, your own site). Serve it with CORS (`Access-Control-Allow-Origin: *`)
  so the website can fetch it.

Then in Flick: Settings > Plugins > Add by URL, paste the link, read the review sheet, tap Install.
Plugins from anywhere but Flick's own list show "Not from Flick" there. An update that adds a host or
tool waits for the user to accept it.
