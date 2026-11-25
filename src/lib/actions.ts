// User actions shared by several screens: open, add folder, store, rescan.

import { isDesktop, hasFsAccess, hasOpfs, pickFiles, pickFolder } from './platform'
import { addFolder as saveFolder, getFolders, scanFolder, mergeScan, sessionFile, storeFile, hash, type Folder, type Item } from './library'
import { kindOf, parseName } from './parse'
import { items, reloadItems, play, notify, queueThumbs, type PlayRequest } from './store'

function chain(reqs: PlayRequest[]): PlayRequest | null {
  for (let i = 0; i < reqs.length - 1; i++) {
    const n = reqs[i + 1]
    reqs[i].next = () => n
  }
  return reqs[0] ?? null
}

export function fileRequest(f: File): PlayRequest | null {
  const kind = kindOf(f.name)
  if (!kind) return null
  const p = parseName(f.name)
  return {
    key: hash(`s:${f.name}:${f.size}`),
    title: p.show ?? p.title,
    subtitle: p.show ? `S${p.season} E${p.episode} · ${p.title}` : p.year ? String(p.year) : undefined,
    kind,
    src: sessionFile(f),
    ref: { t: 'url', url: '' },
  }
}

export function pathRequest(path: string): PlayRequest | null {
  const name = path.split(/[\\/]/).pop() ?? path
  const kind = kindOf(name)
  if (!kind) return null
  const p = parseName(name)
  const known = items.value.find((i) => i.src.t === 'path' && i.src.path === path)
  return {
    key: known?.id ?? hash(path),
    title: p.show ?? p.title,
    subtitle: p.show ? `S${p.season} E${p.episode} · ${p.title}` : p.year ? String(p.year) : undefined,
    kind,
    src: { t: 'path', path },
    ref: known ? { t: 'item', id: known.id } : { t: 'url', url: path },
  }
}

export function playFiles(files: File[]) {
  const reqs = files.map(fileRequest).filter(Boolean) as PlayRequest[]
  const first = chain(reqs)
  if (first) play(first)
  else notify('That file type is not a video or song Flick knows.')
}

export function playPaths(paths: string[]) {
  const first = chain(paths.map(pathRequest).filter(Boolean) as PlayRequest[])
  if (first) play(first)
}

function pickWebFiles(opts: { dir?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (opts.accept) input.accept = opts.accept
    if (opts.dir) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.click()
  })
}

export async function openFiles() {
  if (isDesktop) return playPaths(await pickFiles())
  playFiles(await pickWebFiles({ accept: 'video/*,audio/*,.mkv,.avi,.flac,.m4v,.ts' }))
}

export const scanning = { busy: false }

export async function addFolder() {
  let folder: Folder | null = null
  let files: File[] | undefined
  if (isDesktop) {
    const path = await pickFolder()
    if (!path) return
    folder = { id: hash(path), name: path.split('/').filter(Boolean).pop() ?? path, path }
  } else if (hasFsAccess) {
    try {
      const handle = await (window as unknown as { showDirectoryPicker(o?: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'flick-media', mode: 'read' })
      folder = { id: hash(handle.name + Date.now()), name: handle.name, handle }
    } catch { return }
  } else {
    files = await pickWebFiles({ dir: true })
    if (!files.length) return
    const name = files[0].webkitRelativePath.split('/')[0] || 'Folder'
    folder = { id: hash(name), name, session: true }
  }
  notify(`Scanning ${folder.name}…`, 60000)
  const found = await scanFolder(folder, files)
  if (folder.session) {
    // No lasting access in this browser: keep the items for this visit only.
    const merged = await mergeScan(folder.name, found, false)
    const ids = new Set(merged.map((m) => m.id))
    items.value = [...items.value.filter((i) => !ids.has(i.id)), ...merged]
    queueThumbs(merged)
    notify(`Found ${merged.length} files. This browser only keeps them until you close the tab; use Chrome, Edge or the desktop app to keep folders.`, 7000)
    return
  }
  await saveFolder(folder)
  await mergeScan(folder.name, found)
  await reloadItems()
  notify(`Added ${found.length} files from ${folder.name}.`)
}

export async function rescanAll() {
  const folders = await getFolders()
  let n = 0
  for (const f of folders) {
    try {
      const found = await scanFolder(f)
      await mergeScan(f.name, found)
      n += found.length
    } catch (e) {
      notify(`${f.name}: ${(e as Error).message}`)
    }
  }
  await reloadItems()
  return n
}

export async function storeFiles() {
  if (!hasOpfs) return notify('This browser cannot store media. Try Chrome, Edge, Safari 17 or the desktop app.')
  const files = (await pickWebFiles({ accept: 'video/*,audio/*,.mkv,.flac' })).filter((f) => kindOf(f.name))
  if (!files.length) return
  const est = await navigator.storage.estimate?.()
  const need = files.reduce((a, f) => a + f.size, 0)
  if (est?.quota && est.usage != null && need > est.quota - est.usage) {
    return notify('Not enough browser storage for those files. Add their folder instead.')
  }
  let i = 0
  for (const f of files) {
    i++
    await storeFile(f, (p) => notify(`Storing ${i} of ${files.length}: ${Math.round(p * 100)}%`, 60000))
  }
  await reloadItems()
  notify(`Stored ${files.length} file${files.length > 1 ? 's' : ''} in Flick.`)
}

export function openUrl(url: string) {
  url = url.trim()
  if (!url) return
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || url)
  const p = parseName(name)
  play({ key: hash(url), title: p.title || url, kind: kindOf(name) ?? 'video', url, ref: { t: 'url', url } })
}

export type { Item }
