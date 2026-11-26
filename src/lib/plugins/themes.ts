// Applies an installed theme as CSS variables over the defaults in src/styles.css.
// The theme was validated (tokens, 4.5:1 contrast) at install; this only writes CSS.

import { validateTheme, contrast, type ThemeColors, type ThemeManifest } from './validate'

const STYLE_ID = 'flick-theme'

function vars(c: ThemeColors, dark: boolean): string {
  const ink = contrast('#ffffff', c.accent, dark) >= contrast('#111111', c.accent, dark) ? '#ffffff' : '#111111'
  return [
    `--bg: ${c.bg}`,
    `--bg-2: color-mix(in srgb, ${c.bg} 94%, ${c.fg})`,
    `--surface: ${c.surface}`,
    `--surface-2: color-mix(in srgb, ${c.surface} 93%, ${c.fg})`,
    `--line: ${c.line}`,
    `--text: ${c.fg}`,
    `--dim: ${c.dim}`,
    `--faint: color-mix(in srgb, ${c.dim} 70%, ${c.bg})`,
    `--accent: ${c.accent}`,
    `--accent-2: color-mix(in srgb, ${c.accent} 82%, ${c.fg})`,
    `--accent-ink: ${ink}`,
  ].join('; ')
}

/** The CSS for a theme. `:root:root` outranks the built-in light and dark rules. */
export function themeCss(t: ThemeManifest): string {
  const extra = [
    t.radius !== undefined ? `--radius: ${t.radius}px` : '',
    t.font ? `--font: '${t.font}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` : '',
  ].filter(Boolean).join('; ')
  const dark = `${vars(t.dark, true)}${extra ? '; ' + extra : ''}; color-scheme: dark`
  const light = `${vars(t.light, false)}${extra ? '; ' + extra : ''}; color-scheme: light`
  return [
    `:root:root { ${dark} }`,
    `@media (prefers-color-scheme: light) { :root:root:not([data-theme='dark']) { ${light} } }`,
    `:root:root[data-theme='light'] { ${light} }`,
  ].join('\n')
}

/** Apply a theme, or remove the current one with null. Re-validates so stored data cannot inject CSS. */
export function applyTheme(t: ThemeManifest | null, doc: Document = document) {
  doc.getElementById(STYLE_ID)?.remove()
  if (!t) return
  const safe = validateTheme(t)
  const el = doc.createElement('style')
  el.id = STYLE_ID
  el.textContent = themeCss(safe)
  doc.head.appendChild(el)
}
