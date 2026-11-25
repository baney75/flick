// Subtitle helpers: browsers only play WebVTT, so convert SRT and basic ASS.

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim()
  return 'WEBVTT\n\n' + body + '\n'
}

function assTime(t: string): string {
  // h:mm:ss.cc -> hh:mm:ss.mmm
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{2})$/)
  if (!m) return '00:00:00.000'
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4]}0`
}

export function assToVtt(ass: string): string {
  const lines = ass.replace(/\r\n?/g, '\n').split('\n')
  let format: string[] = []
  const cues: string[] = []
  let inEvents = false
  for (const line of lines) {
    if (/^\[events\]/i.test(line)) { inEvents = true; continue }
    if (/^\[/.test(line)) { inEvents = false; continue }
    if (!inEvents) continue
    if (/^format:/i.test(line)) {
      format = line.slice(7).split(',').map((s) => s.trim().toLowerCase())
      continue
    }
    if (!/^dialogue:/i.test(line) || !format.length) continue
    const parts = line.slice(9).split(',')
    const textIdx = format.indexOf('text')
    const fields = parts.slice(0, textIdx)
    const text = parts.slice(textIdx).join(',')
    const start = fields[format.indexOf('start')]
    const end = fields[format.indexOf('end')]
    const clean = text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim()
    if (clean) cues.push(`${assTime(start)} --> ${assTime(end)}\n${clean}`)
  }
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n'
}

export function toVtt(name: string, text: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.vtt')) return text
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return assToVtt(text)
  return srtToVtt(text)
}

export function vttUrl(name: string, text: string): string {
  return URL.createObjectURL(new Blob([toVtt(name, text)], { type: 'text/vtt' }))
}
