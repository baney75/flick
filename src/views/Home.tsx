import { useState } from 'preact/hooks'
import { items, continueList, playItem, go, stremio, shows, type Progress, openStremioRef } from '../lib/store'
import { Card, ItemCard, Row, useThumb } from '../components/Card'
import { Icon } from '../components/icons'
import { addFolder, openFiles, openUrl, playPaths } from '../lib/actions'
import { continueWatching } from '../lib/stremio'
import { isDesktop } from '../lib/platform'
import { online } from '../lib/offline'
import { downloads } from '../lib/downloads'

function ResumeCard({ k, p }: { k: string; p: Progress }) {
  const ref = p.ref
  const it = ref.t === 'item' ? items.value.find((i) => i.id === ref.id) : undefined
  const thumb = useThumb(it)
  const click = () => {
    if (p.ref.t === 'item') { if (it) playItem(it) }
    else if (p.ref.t === 'stremio') openStremioRef(p.ref)
    else if (p.ref.t === 'url' && p.ref.url) {
      if (p.ref.url.startsWith('/')) playPaths([p.ref.url])
      else openUrl(p.ref.url)
    }
  }
  return <Card key={k} image={p.poster ?? thumb} title={p.title} sub={p.subtitle} pct={p.dur ? p.pos / p.dur : 0} shape="wide" onClick={click} />
}

export function Home() {
  const [url, setUrl] = useState('')
  const all = items.value
  const cont = continueList.value.filter(([, p]) => p.ref.t !== 'url' || p.ref.url)
  const recent = [...all].filter((i) => i.kind === 'video').sort((a, b) => b.addedAt - a.addedAt).slice(0, 24)
  const music = all.filter((i) => i.kind === 'audio').slice(0, 24)
  const st = stremio.value
  const stCont = continueWatching(st.library).slice(0, 20)
  const showList = [...shows.value.values()].slice(0, 20)
  const empty = !all.length && !cont.length && !stCont.length

  const saved = [...downloads.value.values()].filter((d) => d.state === 'done').length
  const toDownloads = () => {
    try { sessionStorage.setItem('flick.tab', 'downloads') } catch { /* private mode */ }
    go('/library')
  }

  return (
    <div class="page">
      {!online.value && (
        <div class="offline-note" role="status">
          <Icon name="download" size={16} />
          <span>{saved ? `You're offline. ${saved > 1 ? `Your ${saved} downloads still play.` : 'Your download still plays.'}` : "You're offline. Downloads you save play without a connection."}</span>
          {saved > 0 && <button class="btn sm" onClick={toDownloads}>Open downloads</button>}
        </div>
      )}
      {empty ? (
        <div class="welcome">
          <div class="welcome-mark"><Icon name="play" size={34} /></div>
          <h1>Drop anything here to play it.</h1>
          <p>Flick plays your videos and music the moment you open them, keeps your place, and turns your folders into a library.</p>
          <div class="welcome-actions">
            <button class="btn primary lg" onClick={openFiles}><Icon name="file" size={18} /> Open a file</button>
            <button class="btn lg" onClick={addFolder}><Icon name="folder" size={18} /> Add a folder</button>
            <button class="btn lg" onClick={() => go('/stremio')}><Icon name="stremio" size={18} /> Link Stremio</button>
            <button class="btn lg" onClick={() => go('/servers')}><Icon name="server" size={18} /> Connect Plex or Jellyfin</button>
          </div>
          <form class="url-form" onSubmit={(e) => { e.preventDefault(); openUrl(url) }}>
            <Icon name="link" size={16} />
            <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="Or paste a video or stream URL (MP4, HLS .m3u8)" aria-label="Stream URL" />
            <button class="btn" disabled={!url.trim()}>Play</button>
          </form>
          {!isDesktop && <p class="small dim">Tip: the Mac app also plays MKV, AVI and HEVC files and opens straight from Finder.</p>}
        </div>
      ) : (
        <>
          <header class="page-head">
            <h1>Home</h1>
            <div class="head-actions">
              <button class="btn" onClick={openFiles}><Icon name="file" size={16} /> Open</button>
              <button class="btn" onClick={addFolder}><Icon name="plus" size={16} /> Add folder</button>
            </div>
          </header>
          {cont.length > 0 && (
            <Row title="Continue watching">{cont.map(([k, p]) => <ResumeCard k={k} p={p} />)}</Row>
          )}
          {stCont.length > 0 && (
            <Row title="Continue on Stremio" action={<a class="link" href="#/stremio">Stremio</a>}>
              {stCont.map((li) => (
                <Card image={li.poster} title={li.name} shape="poster" pct={li.state?.duration ? (li.state.timeOffset ?? 0) / li.state.duration : 0}
                  sub={li.type === 'series' && li.state?.video_id ? epFromVideoId(li.state.video_id) : undefined}
                  onClick={() => go(`/stremio/${li.type}/${encodeURIComponent(li._id)}${li.state?.video_id && li.type === 'series' ? `?v=${encodeURIComponent(li.state.video_id)}` : ''}`)} />
              ))}
            </Row>
          )}
          {recent.length > 0 && (
            <Row title="Recently added" action={<a class="link" href="#/library">See all</a>}>
              {recent.map((it) => <ItemCard it={it} onClick={() => playItem(it)} />)}
            </Row>
          )}
          {showList.length > 0 && (
            <Row title="Shows">
              {showList.map((eps) => <ShowCard eps={eps} />)}
            </Row>
          )}
          {music.length > 0 && (
            <Row title="Music">{music.map((it) => <ItemCard it={it} onClick={() => playItem(it)} />)}</Row>
          )}
        </>
      )}
    </div>
  )
}

export function ShowCard({ eps }: { eps: import('../lib/library').Item[] }) {
  const first = eps[0]
  const thumb = useThumb(first)
  const seasons = new Set(eps.map((e) => e.season ?? 1)).size
  return <Card image={thumb} title={first.show!} sub={`${seasons > 1 ? `${seasons} seasons · ` : ''}${eps.length} episodes`}
    shape="wide" onClick={() => go(`/show/${encodeURIComponent(first.show!.toLowerCase())}`)} />
}

function epFromVideoId(v: string) {
  const m = v.match(/:(\d+):(\d+)$/)
  return m ? `S${m[1]} E${m[2]}` : undefined
}
