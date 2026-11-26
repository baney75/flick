// The stream preferences in Settings (SPEC-best-stream rule 7): audio and subtitle languages in the
// user's order, and a quality cap. They sync with the other settings; the device stays out of them.

import type { MaxQuality } from './pick'
import { langCode } from './release'

export interface StreamPrefs { audio: string[]; subs: string[]; maxQuality: MaxQuality }

/** The device's languages as base codes, de-duplicated, with English added when absent. */
export function defaultAudio(langs: readonly string[]): string[] {
  const out = [...new Set(langs.map(langCode).filter((l): l is string => !!l))]
  return out.includes('en') ? out : [...out, 'en']
}

export function defaultPrefs(langs: readonly string[]): StreamPrefs {
  return { audio: defaultAudio(langs), subs: [], maxQuality: '4K' }
}

/** Languages the Settings lists offer to add. */
export const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'hi', 'ar', 'nl', 'pl', 'tr', 'sv', 'da', 'no', 'fi', 'el', 'he', 'cs', 'hu', 'ro', 'uk', 'vi', 'th', 'id']

const QUALITY_CAPS = ['4K', '1080p', '720p', 'SD']
/** Whether a synced value fits its preference key; other keys pass. A bad value from another device is skipped. */
export function validPref(key: string, v: unknown): boolean {
  if (key === 'audio' || key === 'subs') return Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string' && /^[a-z]{2}$/.test(x))
  if (key === 'maxQuality') return QUALITY_CAPS.includes(v as string)
  return true
}
