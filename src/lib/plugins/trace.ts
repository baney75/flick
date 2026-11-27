// Step marks for the desktop self-test (scripts/desktop-selftest.mjs): each mark ends one install step.
// Nothing listens outside a self-test run.

let sink: ((step: string) => void) | null = null

export function traceTo(fn: ((step: string) => void) | null) { sink = fn }
export function mark(step: string) { sink?.(step) }
