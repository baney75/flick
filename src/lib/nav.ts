// The main bar: Home, Library, Settings. Plugins and servers have no bar items of their own.

/** The bar item a route belongs to: plugin pages sit under Home, reading under Library, servers under Settings. */
export function tabOf(r: string): string {
  const first = r.split('?')[0].split('/').filter(Boolean)[0] ?? ''
  if (['library', 'show', 'read', 'read-url', 'listen'].includes(first)) return '/library'
  if (first === 'continue') return '/continue'
  if (['settings', 'servers', 'setup', 'pair'].includes(first)) return '/settings'
  return '/'
}

/** How many catalog rows each source plugin shows on Home; its page has the rest. */
export const HOME_ROWS_PER_SOURCE = 3
