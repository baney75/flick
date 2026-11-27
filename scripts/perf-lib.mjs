// The parts of scripts/perf.mjs that need no browser: statistics, the budget check and the tables.
// tests/perf-lib.test.ts covers them.

/** Median and p95 (nearest rank) of a list of numbers. */
export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  if (!s.length) return { median: NaN, p95: NaN, n: 0 }
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return { median: mid, p95: at(0.95), n: s.length }
}

/** A budget key names one metric, or every metric under a prefix with a trailing `*`. */
export function matches(key, metric) {
  return key.endsWith('*') ? metric.startsWith(key.slice(0, -1)) : key === metric
}

/**
 * Every budget miss, by metric. A budget that matches no measured metric is a miss too, so a
 * broken scenario can never pass by measuring nothing.
 */
export function gate(metrics, budgets) {
  const misses = []
  for (const [key, limit] of Object.entries(budgets)) {
    const hit = Object.keys(metrics).filter((m) => matches(key, m))
    if (!hit.length) { misses.push({ metric: key, p95: null, budget: limit, why: 'not measured' }); continue }
    for (const m of hit) {
      const v = metrics[m].p95
      if (!(v <= limit)) misses.push({ metric: m, p95: v, budget: limit, why: Number.isNaN(v) ? 'no samples' : 'over budget' })
    }
  }
  return misses
}

/** The budget that applies to one metric: an exact key wins over a prefix. */
export function budgetFor(metric, budgets) {
  if (metric in budgets) return budgets[metric]
  const keys = Object.keys(budgets).filter((k) => matches(k, metric)).sort((a, b) => b.length - a.length)
  return keys.length ? budgets[keys[0]] : undefined
}

const fmt = (v, unit) => (v == null || Number.isNaN(v) ? '-' : unit === 'score' ? v.toFixed(3) : unit === '%' ? `${v.toFixed(1)}%` : `${Math.round(v)}`)

/** A Markdown table of every metric, with its budget and whether it passed. */
export function table(metrics, budgets) {
  const rows = ['| Metric | Median | p95 | Budget | |', '| --- | --- | --- | --- | --- |']
  for (const [m, v] of Object.entries(metrics)) {
    const b = budgetFor(m, budgets)
    rows.push(`| ${m} | ${fmt(v.median, v.unit)} | ${fmt(v.p95, v.unit)} | ${b == null ? '' : fmt(b, v.unit)} | ${b == null ? '' : v.p95 <= b ? 'ok' : 'MISS'} |`)
  }
  return rows.join('\n')
}

/** Before and after, p95 against p95, for a PR body. */
export function compare(base, cur, budgets) {
  const rows = ['| Metric | Before p95 | After p95 | Change | Budget |', '| --- | --- | --- | --- | --- |']
  const names = [...new Set([...Object.keys(base), ...Object.keys(cur)])]
  for (const m of names) {
    const a = base[m], b = cur[m], unit = (b ?? a).unit
    const d = a && b ? b.p95 - a.p95 : NaN
    const pct = a && b && a.p95 ? ` (${d > 0 ? '+' : ''}${Math.round((d / a.p95) * 100)}%)` : ''
    const bud = budgetFor(m, budgets)
    rows.push(`| ${m} | ${fmt(a?.p95, unit)} | ${fmt(b?.p95, unit)} | ${Number.isNaN(d) ? '-' : `${d > 0 ? '+' : ''}${fmt(d, unit)}${pct}`} | ${bud == null ? '' : fmt(bud, unit)} |`)
  }
  return rows.join('\n')
}

/** The least a median must worsen, by unit, to count as a regression: below it is run to run noise. */
export const FLOOR = { ms: 30, '%': 10, score: 0.03 }

/**
 * Budgeted metrics clearly worse than a base run on the same machine: the median above the base's
 * median by half again and by at least FLOOR. For a machine too slow for the budgets themselves (a CI
 * runner), where only a change between two builds measured side by side is reliable. Medians, not
 * p95: of five runs the p95 is the slowest one, and a single stall on a shared runner sets it.
 */
export function regressions(base, cur, budgets) {
  const out = []
  const budgeted = (m) => budgetFor(m, budgets) != null
  for (const [m, a] of Object.entries(base)) {
    if (!budgeted(m) || Number.isNaN(a.median)) continue
    const v = cur[m]
    if (!v || Number.isNaN(v.median)) { out.push({ metric: m, median: null, base: a.median, allowed: null, why: 'not measured' }); continue }
    const allowed = a.median + Math.max(FLOOR[v.unit] ?? FLOOR.ms, a.median * 0.5)
    if (v.median > allowed) out.push({ metric: m, median: v.median, base: a.median, allowed, why: 'regressed' })
  }
  return out
}
