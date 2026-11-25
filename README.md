# Flick

A fast media player and library. It plays your videos and music the moment you open them, builds a library from your folders, and links to Stremio, Plex and Jellyfin. It runs as a website and as a native app for Mac, Windows, Linux, iOS, Android and Android TV, all from one codebase.

## What it does

- **Plays instantly.** Drop a file, double-click it in Finder, or paste a stream URL (MP4, WebM, HLS). On the desktop app, MKV, AVI and odd audio codecs convert through ffmpeg by copying streams, so a movie is ready in seconds.
- **Keyboard first.** Space, J/K/L, arrows, F, M, C, `[` `]` for speed, `,` `.` for frame steps, 0 to 9 to jump, N for the next episode. Press `?` in the player for the full list.
- **Subtitles.** Sidecar `.srt`/`.vtt`/`.ass` files load on their own. Subtitles inside MKV files load on the desktop app. Drop a subtitle file on the video to add one.
- **Library.** Add a folder and Flick names every file, groups shows by season and episode, makes thumbnails and keeps your place. A virtual grid keeps 50,000 items smooth. Search with `/`.
- **Stored media.** In the browser, copy files into Flick's private storage so they stay available offline.
- **Stremio.** Sign in to bring your installed addons, your Stremio library and Continue Watching. Search and browse catalogs, open a title, pick a stream. Direct streams play in Flick; torrent streams play through the Stremio streaming server when it runs on the same computer. You can also add addons by URL without an account.
- **Plex and Jellyfin.** Sign in with Plex (PIN on plex.tv) or connect Jellyfin/Emby with a username. Everything joins your library and search.
- **TV.** D-pad navigation and a 10-foot focus style for Android TV and remotes.
- **Private.** No account, no analytics, no ads. Everything stays on the device.

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
