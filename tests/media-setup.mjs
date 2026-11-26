// Makes the audio fixtures the tests read, with ffmpeg, so no media binaries live in the repo.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const DIR = 'test-media/audiobook'
const CHAPTERS = [['Opening', 0], ['The Middle', 4], ['Ending', 8.5]]

/** Tests get the files as base64 and the chapter list through inject(). */
export default function setup({ provide }) {
  if (!existsSync(`${DIR}/book.m4b`)) make()
  provide('chapters', CHAPTERS.map(([title, start]) => ({ title, start })))
  provide('media', Object.fromEntries(readdirSync(DIR).map((n) => [n, readFileSync(`${DIR}/${n}`).toString('base64')])))
}

export function make() {
  mkdirSync(DIR, { recursive: true })
  const meta = `;FFMETADATA1\ntitle=Test Audiobook\nartist=Jane Doe\n` + CHAPTERS.map(([t, s], i) =>
    `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s * 1000}\nEND=${(CHAPTERS[i + 1]?.[1] ?? 12) * 1000}\ntitle=${t}\n`).join('')
  writeFileSync(`${DIR}/meta.txt`, meta)
  const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a])
  ff('-f', 'lavfi', '-i', 'color=c=0x2266aa:s=96x96', '-frames:v', '1', `${DIR}/cover.jpg`)
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:d=12', '-i', `${DIR}/cover.jpg`, '-i', `${DIR}/meta.txt`, '-map', '0:a', '-map', '1:v',
    '-map_metadata', '2', '-map_chapters', '2', '-c:a', 'aac', '-b:a', '32k', '-c:v', 'copy', '-disposition:v', 'attached_pic', `${DIR}/book.m4b`)
  for (const n of [1, 2]) {
    ff('-f', 'lavfi', '-i', `sine=frequency=${300 + n * 100}:d=3`, ...(n === 1 ? ['-i', `${DIR}/cover.jpg`, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-id3v2_version', '3', '-metadata:s:v', 'comment=Cover (front)'] : []),
      '-c:a', 'libmp3lame', '-b:a', '32k', `${DIR}/0${n} Part.mp3`)
  }
}
