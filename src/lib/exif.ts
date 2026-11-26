// Capture dates of photos: EXIF DateTimeOriginal read from the start of a JPEG.

/** "2024:06:01 10:20:30" (EXIF) or "2024-06-01T10:20:30" (flick-server) as this device's wall clock, in ms. */
export function wallClock(s: string | undefined): number | undefined {
  const m = s?.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return undefined
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number)
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
  return new Date(y, mo - 1, d, h, mi, se).getTime()
}

/**
 * EXIF DateTimeOriginal from the start of a JPEG, or undefined. Reads only the APP1 segment, so
 * the first 128 KB of the file are enough.
 */
export function exifTaken(buf: ArrayBuffer): number | undefined {
  const v = new DataView(buf)
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return undefined
  let at = 2
  while (at + 4 <= v.byteLength && v.getUint8(at) === 0xff) {
    const marker = v.getUint8(at + 1)
    const len = v.getUint16(at + 2)
    if (marker === 0xda || marker === 0xd9) return undefined
    if (len < 2) return undefined
    if (marker === 0xe1 && len >= 8 && at + 10 <= v.byteLength && v.getUint32(at + 4) === 0x45786966 && v.getUint16(at + 8) === 0) {
      return tiffTaken(new DataView(buf, at + 10, Math.min(len - 8, v.byteLength - at - 10)))
    }
    at += 2 + len
  }
  return undefined
}

function tiffTaken(t: DataView): number | undefined {
  try {
    const le = t.getUint16(0) === 0x4949
    const u16 = (o: number) => t.getUint16(o, le)
    const u32 = (o: number) => t.getUint32(o, le)
    // The value of a tag in the IFD at `ifd`, as its 4 byte value or offset field.
    const find = (ifd: number, tag: number) => {
      const n = u16(ifd)
      for (let i = 0; i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12
      return -1
    }
    const ptr = find(u32(4), 0x8769)
    if (ptr < 0) return undefined
    const e = find(u32(ptr + 8), 0x9003)
    if (e < 0 || u16(e + 2) !== 2 || u32(e + 4) < 19) return undefined
    const off = u32(e + 8)
    let s = ''
    for (let i = 0; i < 19; i++) s += String.fromCharCode(t.getUint8(off + i))
    return wallClock(s)
  } catch { return undefined }
}
