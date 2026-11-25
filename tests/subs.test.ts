import { describe, it, expect } from 'vitest'
import { srtToVtt, assToVtt, toVtt } from '../src/lib/subs'

describe('subtitles', () => {
  it('converts SRT to VTT', () => {
    const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,250\r\nWorld\r\n'
    expect(srtToVtt(srt)).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nHello\n\n2\n00:00:04.000 --> 00:00:05.250\nWorld\n')
  })
  it('converts ASS dialogue and strips styling', () => {
    const ass = '[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hi,{\\i0} there\\Nfriend\n'
    expect(assToVtt(ass)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHi, there\nfriend\n')
  })
  it('passes VTT through', () => {
    expect(toVtt('a.vtt', 'WEBVTT\n\nx')).toBe('WEBVTT\n\nx')
  })
})
