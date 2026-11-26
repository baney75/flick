# Flick

A fast media player and library. It plays your videos and music the moment you open them, builds a library from your folders, links to Plex, Jellyfin and Kodi, and takes plugins for other sources such as Stremio. It runs as a website and as a native app for Mac, Windows, Linux, iOS, Android and Android TV, all from one codebase.

## What it does

- **Plays instantly.** Drop a file, double-click it in Finder, or paste a stream URL (MP4, WebM, HLS). On the desktop app, MKV, AVI and odd audio codecs convert through ffmpeg by copying streams, so a movie is ready in seconds.
- **Keyboard first.** Space, J/K/L, arrows, F, M, C, `[` `]` for speed, `,` `.` for frame steps, 0 to 9 to jump, N for the next episode. Press `?` in the player for the full list.
- **Subtitles.** Sidecar `.srt`/`.vtt`/`.ass` files load on their own. Subtitles inside MKV files load on the desktop app. Drop a subtitle file on the video to add one.
- **Library.** Add a folder and Flick names every file, groups shows by season and episode, makes thumbnails and keeps your place. A virtual grid keeps 50,000 items smooth. Search with `/`.
- **Stored media.** In the browser, copy files into Flick's private storage so they stay available offline.
- **Plugins.** Sources and color themes install from **Settings > Plugins**: from Flick's list, a URL or a file. Each source plugin runs sealed off in its own sandbox, reaches only the hosts it declared, and shows you those hosts before you install it. Write your own with `docs/PLUGINS.md`.
- **Stremio, as a plugin.** Install it from Flick's list. Sign in to bring your installed addons, your Stremio library and Continue Watching, or use Cinemeta and OpenSubtitles without an account. Direct streams play in Flick; torrent streams play through the Stremio streaming server when it runs on the same computer. If you used Flick's old Stremio section, the plugin installs itself on first launch with your sign-in, addons and progress moved over.
- **Plex and Jellyfin.** Sign in with Plex (PIN on plex.tv) or connect Jellyfin/Emby with a username. Everything joins your library and search.
- **Kodi.** In the Flick apps, connect a Kodi box (turn on Settings > Services > Control > Allow remote control via HTTP). Movies, episodes and songs join your library and stream straight from Kodi, with or without a Kodi password. Phones and TVs play MP4, M4V, MOV, WebM and common audio; MKV and AVI need the desktop app (Mac, Windows or Linux), which converts them through ffmpeg like local files.
- **TV.** D-pad navigation and a 10-foot focus style for Android TV and remotes.
- **Private.** No account, no analytics, no ads. Everything stays on the device.

## Set up Flick for someone (agents)

Write one JSON payload, turn it into a link, and send it. The person opens the link, sees every item Flick will add, and taps **Connect all**. Nothing changes before that tap. On the desktop app, use **Settings > Import setup file** with the same JSON.

```json
{
  "v": 1,
  "plugins": ["/plugins/stremio.js"],
  "stremioAddons": ["https://addon.example/manifest.json"],
  "servers": [
    { "type": "plex", "name": "Den", "url": "https://192-168-1-20.example.plex.direct:32400", "token": "PLEX_TOKEN" },
    { "type": "jellyfin", "url": "http://192.168.1.20:8096", "token": "JELLYFIN_API_KEY", "userId": "JELLYFIN_USER_ID" }
  ],
  "folders": ["/Users/me/Movies"],
  "settings": { "theme": "dark", "skipSeconds": 15, "autoplayNext": true, "speed": 1 }
}
```

- `v` must be `1`. Every other field is optional. Unknown keys are dropped.
- `plugins`: up to 20 plugin addresses, `https://` URLs or Flick's own `/plugins/<name>.js`. The review shows each one with the hosts it reaches. Use only plugins the person chose.
- `stremioAddons`: up to 50 manifest URLs (`https://` or `stremio://`). Use only addons the person chose. They go into the Stremio plugin, which the review offers to install when it is missing.
- `servers`: tokens only, never passwords. Jellyfin needs `userId`. URLs must be `http` or `https`.
- `folders`: desktop paths. The website skips them.
- `settings`: any of `autoplayNext`, `speed`, `volume`, `skipSeconds`, `theme` (`system`, `dark`, `light`).

Build the link from base64url of the JSON:

```sh
echo "https://flick-player.pages.dev/#/setup?c=$(node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(0)).toString("base64url"))' < setup.json)"
```

The link holds server tokens: send it only to the person it is for. **Settings > Share my setup** builds the same link from your own plugins, Stremio addons, servers and settings.

## Run it

```sh
npm install
npm run dev            # website at http://localhost:5178
npm run tauri dev      # desktop app
npm run tauri build    # release app in src-tauri/target/release/bundle
```

Desktop needs Rust. MKV/AVI playback and thumbnails need ffmpeg (`brew install ffmpeg`); without it the Mac app uses Quick Look thumbnails and plays MP4, MOV, M4V and WebM.

## Check

```sh
npm run check   # types, unit tests, build, and a headless smoke test that plays a real file
```

## Builds

`.github/workflows/release.yml` builds Mac (universal), Windows, Linux, Android (phones, tablets and Android TV) and an iOS simulator build on a `v*` tag. Installable iOS builds and App Store releases need an Apple developer team.
