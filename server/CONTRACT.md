# flick-server HTTP API, version 1

`flick-server` turns any Mac, Windows or Linux machine (or a NAS through Docker) into a Flick media source.
Flick apps and the website connect to it over HTTPS (Tailscale Serve or a Cloudflare tunnel) or plain HTTP on a LAN.

## Auth

- Access code: 32 random bytes, base64url without padding (43 chars). Generated on first run, stored in the
  config dir as `token` (mode 0600 on Unix). `--new-code` replaces it.
- Every route except `GET /api/info`, `OPTIONS` and the web app files needs the code, as
  `Authorization: Bearer <code>` or the query parameter `t=<code>` (media elements cannot send headers).
- Compare in constant time. A missing or wrong code gets `401` with JSON `{"error":"..."}`.

## CORS (every response)

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization, Range
Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
```
`OPTIONS` on any path answers `204`. A wildcard origin is safe here because auth is a bearer code, never a cookie.

## Routes

`GET /api/info` (no auth)
```json
{"app":"flick-server","v":1,"name":"Living room NAS","version":"0.1.0"}
```

`GET /api/library` (auth). `?rescan=1` rescans first.
```json
{"name":"Living room NAS","folders":["Movies","TV"],"items":[
  {"id":"9f86d081884c7d65","folder":"Movies","path":"Heat (1995)/Heat (1995).mkv","name":"Heat (1995).mkv",
   "kind":"video","ext":"mkv","size":7340032000,"mtime":1732550400000}
]}
```
- `id`: first 16 hex chars of SHA-256 of `<folder>/<path>`. Stable across restarts and rescans.
- `folder`: label of the shared root (its directory name; a duplicate gets ` 2`, ` 3`).
- `path`: relative to the root, `/` separators on every OS.
- `kind`: `video` (mp4 m4v mov mkv webm avi ts m2ts wmv flv mpg mpeg 3gp ogv), `audio` (mp3 m4a m4b aac flac
  wav ogg oga opus alac aiff wma), `book` (pdf). Other files are not listed.
- `mtime`: milliseconds since the epoch.
- Hidden files and folders (leading `.`) are skipped; symlinks are not followed. Cap of 200,000 items.

`GET|HEAD /media/<id>` (auth): the file's bytes.
- Without `Range`: `200`, `Accept-Ranges: bytes`, `Content-Length`.
- One range (`bytes=a-b`, `bytes=a-`, `bytes=-n`): `206` with `Content-Range: bytes a-b/total`.
- Unsatisfiable: `416` with `Content-Range: bytes */total`. Multiple ranges: serve the first.
- `Content-Type` from the extension (video/mp4, video/x-matroska, video/webm, video/quicktime, audio/mpeg,
  audio/mp4, audio/flac, audio/ogg, audio/wav, application/pdf, application/octet-stream otherwise).
- Only ids in the index are served. No path ever comes from the URL, so nothing outside a shared root is reachable.

Anything else under `GET`: the Flick web app, when one is available (`--web <dir>`, or built in with the
`embed-web` feature), with `index.html` for unknown paths. Without one: a short plain-text page saying the server
is running and to connect from Flick.

## Setup link the server prints

`<base>/#/setup?c=<base64url(JSON)>`, the existing Flick setup link, with:
```json
{"v":1,"servers":[{"type":"flick","name":"Living room NAS","url":"https://nas.tail1234.ts.net","token":"<code>"}]}
```
`<base>` is the server's own public URL when it serves the web app, otherwise `https://flick-player.pages.dev`.
`url` has no trailing slash.

## Client mapping (Flick web app)

- `Server.type` gains `'flick'`; `token` holds the access code.
- Item id: `hash(`${server.id}:${x.id}`)`. Source: `{ t: 'url', url: `${s.url}/media/${x.id}?t=${token}` }`.
- Titles, shows, seasons and episodes come from the file name, the same way local files are named.
