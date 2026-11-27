export const IDENTIFIER: string
export const LIMIT_MS: number
export function failures(report: unknown): string[]
export function table(report: unknown): string
export const PRODUCT: string
export function override(conf: { app: { windows: Record<string, unknown>[] } }): { identifier: string; productName: string; app: { windows: Record<string, unknown>[] } }
