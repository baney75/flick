# Flick brand

## The mark

Three play frames flicking past, from amber to ember: the player that is fast, and the base that
plugins stack onto. The drawing is `public/icon.svg`; `src/components/Logo.tsx` draws the same thing in
the app.

- Keep the dark tile. On a dark page give it a 1px shadow, never an outline.
- Don't recolor, rotate, stretch or add a fourth frame. Don't put the mark inside another shape.
- Smallest size: 16px. Below 24px leave the wordmark off.
- Wordmark: "Flick" in the app's UI font, weight 750, letter spacing -0.02em, set to the right of the
  mark with a gap of one third of the mark's width.

## Colors

| Name | Hex | Use |
| --- | --- | --- |
| Ink | `#0e0d11` to `#211d26` | the tile, dark backgrounds, theme-color |
| Amber | `#ffc15e` | first frame |
| Flame | `#ff8a3d` | second frame |
| Ember | `#ff6b3d` to `#ee3129` | the front frame; the app accent is `#ff5a36` (dark) and `#e8431f` (light) |

## Icons in the repo

| File | Size | Where |
| --- | --- | --- |
| `public/icon.svg` | any | favicon, PWA icon |
| `public/icon-512.png` | 512 | PWA icon, rounded |
| `public/icon-maskable-512.png` | 512 | Android PWA, full bleed |
| `public/apple-touch-icon.png` | 180 | iPhone home screen, full bleed |
| `src-tauri/icons/` | all | desktop and mobile apps, made with `npx tauri icon` from a 1024px render with 100px padding and a soft shadow |

To redraw: edit `public/icon.svg` and `Logo.tsx` together, render the PNGs with headless Chrome, then
run `npx tauri icon <1024px png>`.

## Themes

A theme plugin (`docs/PLUGINS.md`) changes the app's colors, never the mark.
