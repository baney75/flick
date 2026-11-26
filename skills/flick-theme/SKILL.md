---
name: flick-theme
description: Use when someone asks you to make, fix or publish a Flick theme, the theme.json file that sets Flick's colors, corner radius and font for light and dark mode.
---

# Make a Flick theme

A theme is one JSON file. It runs no code. Flick reads six color tokens per mode, a radius and a font,
and refuses any theme whose text does not reach 4.5:1 contrast. Contract: the "A theme" section of
`docs/PLUGINS.md` (https://github.com/baney75/flick/blob/main/docs/PLUGINS.md).

## Steps

1. Start from this file:

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

2. Set your own `id` (reverse-DNS, lowercase), `name` and `author`.
3. Pick colors for both modes. `bg` is the window, `surface` panels and cards, `fg` text, `dim`
   secondary text, `line` borders, `accent` buttons and highlights. Colors are `#rgb`, `#rrggbb` or
   `#rrggbbaa`.
4. Keep `fg` on `bg` and on `surface` at 4.5:1 or better in both modes. Keep `dim` readable too.
5. `radius` is 0 to 24. `font` is a family name that is already on the device (Flick downloads no
   fonts); leave it out to keep Flick's system font.

## Check

```sh
npm run plugin:check -- path/to/theme.json
```

It validates the file with Flick's own code and prints each contrast ratio. Done means it exits 0.

## Publish

Host the file at any `https://` URL with CORS, for example a GitHub gist's **Raw** link without the
commit hash (`https://gist.githubusercontent.com/<user>/<id>/raw/theme.json`). In Flick: Settings >
Plugins > Add by URL, then pick it under Theme.
