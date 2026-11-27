// Pure helpers for Settings > Plugins (src/views/Hub.tsx).

/** Which group a route asks for: `#/servers` and `#/settings/servers` the Servers group, and so on. */
export function anchorOf(r: string): 'servers' | 'services' | 'plugins' | null {
  if (/^\/(settings\/)?servers\b/.test(r)) return 'servers'
  if (/^\/(settings\/)?services\b/.test(r)) return 'services'
  if (/^\/settings\/plugins\b/.test(r)) return 'plugins'
  return null
}

/**
 * A short "reaches" line for Flick's list: '*' is any public website, otherwise the sites by name,
 * subdomains folded together, at most two and a count.
 */
export function reachLine(hosts: string[] | undefined): string {
  if (!hosts) return ''
  if (hosts.includes('*')) return 'Reaches any public website'
  if (!hosts.length) return 'Reaches nothing online'
  const sites = [...new Set(hosts.map((h) => h.replace(/^\*\./, '').split('.').slice(-2).join('.')))]
  return `Reaches ${sites.slice(0, 2).join(', ')}${sites.length > 2 ? ` and ${sites.length - 2} more` : ''}`
}
