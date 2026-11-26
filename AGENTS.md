# Flick: notes for agents

- Stack: Preact + TypeScript + Vite (web UI in `src/`), Tauri 2 + Rust (desktop and mobile shell in `src-tauri/`).
- Done means `npm run check` passes (types, vitest, build, headless smoke in `scripts/smoke.mjs`), plus `cargo clippy` in `src-tauri` for Rust changes. For player or UI changes, also run the desktop app and try the steps live.
- `flick-server` (`server/`, the media server for NAS and desktop sharing): `cargo test --manifest-path server/Cargo.toml` and `cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings`.
- Sync changes (`src/lib/sync/`, `relay/`): also run `npm run check:sync` (relay checks under `wrangler dev`, then two browser profiles pair and sync).
- Release builds on this Mac: keep `[profile.release.build-override] strip = "none"` in `src-tauri/Cargo.toml`. Xcode 27's strip corrupts proc-macro dylibs, and LTO with panic=abort failed the same way.
- The web build must keep working without Tauri: every desktop call goes through `src/lib/platform.ts` and is guarded by `isDesktop`.
- Never add stream sources, plugins or addons on the user's behalf. Flick uses only the plugins the user installs and, in the Stremio plugin, only the addons the user chose. The one exception is the documented one-time Stremio migration in `docs/PLUGINS.md`.
- Plugins and themes: the contract is `docs/PLUGINS.md`; to write one, follow `skills/flick-plugin/SKILL.md` or `skills/flick-theme/SKILL.md` and pass `npm run plugin:check -- <file>`.
- No em or en dashes in prose.
