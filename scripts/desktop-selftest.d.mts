export const PREFIX: string
export const TOOLS: string
export const TOOLS_LAYOUT: { dir: string; bin: string; sum: string }
export function ensureTools(dir?: string): Promise<string>
export function identifierFor(root: string): string
export function profileDirs(id: string, home?: string): string[]
export function removeDirs(paths: string[], fs?: { lstatSync(p: string): { isSymbolicLink(): boolean; isDirectory(): boolean }; rmSync(p: string, o: object): void }): string[]
export const LIMIT_MS: number
export function failures(report: unknown): string[]
export function table(report: unknown): string
export const PRODUCT: string
export function override(conf: { app: { windows: Record<string, unknown>[] } }, identifier: string): { identifier: string; productName: string; app: { windows: Record<string, unknown>[] } }
export function invokeSummary(invokes: { cmd: string; start: number; end: number; ok: boolean }[], untilMs: number): { count: number; sumMs: number; spanMs: number; maxConcurrent: number; serial: number; by: Record<string, { count: number; totalMs: number; maxMs: number; failed: number }> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function medianReport(reports: any[]): any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function perfMarkdown(app: any, browser: any): string
export function webkitPath(webkit: { executablePath(): string }, cache?: string, fs?: { existsSync(p: string): boolean; readdirSync(p: string): string[] }): string | undefined
export function youtubeFailures(report: unknown): string[]
export function youtubeTable(report: unknown): string
