// The live remux (SPEC-playback rules 2 to 4): ffmpeg reads a stream the web view cannot open and
// writes a local fMP4 HLS event playlist in a fresh folder, which plays once it lists 3 segments. A seek
// outside what a run wrote starts a new run there with -ss; the player adds the run's start to its clock.
// One run plays at a time: a new run, remux_stop (the player closing) or the app's exit stops it.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;

use super::playback::{probe_cached, Probes, StreamProbe, COPY_AUDIO};
use super::ytdlp::{kill_tree, own_group};
use super::{basic, find_tool, input_args, is_url, video_args};

const FIRST_SEGMENT: Duration = Duration::from_secs(30);
const DAY: Duration = Duration::from_secs(86_400);
const STOPPED: &str = "Playback stopped.";
const NEEDS_FFMPEG: &str = "This file needs ffmpeg to play. Install it with: brew install ffmpeg";

/// ffmpeg's arguments for one run: `input` from `at` seconds into `dir`/index.m3u8.
pub fn run_args(
    input: &str,
    auth: Option<&str>,
    p: &StreamProbe,
    at: f64,
    dir: &Path,
) -> Vec<String> {
    let mut a: Vec<String> = ["-nostdin", "-loglevel", "error"].map(String::from).into();
    if is_url(input) {
        a.extend(
            [
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "5",
            ]
            .map(String::from),
        );
    }
    if at > 0.0 {
        a.extend(["-ss".into(), format!("{at:.3}")]);
    }
    a.extend(input_args(input, auth));
    // Capital V: real video only, never an album's cover picture, which would hold every segment
    // to its one keyframe and leave an audio file with nothing to play until it ends.
    a.extend(["-map", "0:V:0?", "-map", "0:a:0?"].map(String::from));
    a.extend(video_args(p.video.as_deref()));
    match p.audio.as_deref() {
        Some(c) if COPY_AUDIO.contains(&c) => a.extend(["-c:a", "copy"].map(String::from)),
        Some(_) => {
            let ch = if p.channels > 2 { "6" } else { "2" };
            a.extend(["-c:a", "aac", "-b:a", "384k", "-ac", ch].map(String::from));
        }
        None => {}
    }
    a.extend(
        [
            "-sn",
            "-f",
            "hls",
            "-hls_segment_type",
            "fmp4",
            "-hls_time",
            "4",
        ]
        .map(String::from),
    );
    a.extend(
        [
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "independent_segments",
        ]
        .map(String::from),
    );
    a.extend(["-hls_fmp4_init_filename", "init.mp4"].map(String::from));
    a.push(dir.join("index.m3u8").to_string_lossy().into_owned());
    a
}

/// Segments the playlist lists so far.
/// WebKit starts a growing playlist only once it lists 3 segments. Given fewer, it waits a whole
/// target duration (up to 10 s with long keyframe gaps) before it reads the playlist again, so a run
/// answers at 3 segments, or sooner when ffmpeg has written the whole stream.
pub const READY_SEGMENTS: usize = 3;

/// Whether a playlist's text is ready to hand to the web view.
pub fn ready_to_play(text: &str) -> bool {
    let n = text
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .count();
    n >= READY_SEGMENTS || (n > 0 && text.contains("#EXT-X-ENDLIST"))
}

pub fn segments(playlist: &Path) -> usize {
    std::fs::read_to_string(playlist)
        .map(|t| {
            t.lines()
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .count()
        })
        .unwrap_or(0)
}

fn last_line(p: &Path) -> String {
    let t = std::fs::read_to_string(p).unwrap_or_default();
    t.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

#[derive(Default)]
struct Run {
    /// Changes with every run, so an older call still waiting can tell it was replaced.
    id: u64,
    /// The player that asked for this run, so a player closing stops only its own run.
    owner: String,
    child: Option<Child>,
    dir: Option<PathBuf>,
}

#[derive(Default)]
pub struct Live {
    run: Mutex<Run>,
}

fn end(child: Option<Child>, dir: Option<PathBuf>) {
    if let Some(mut c) = child {
        kill_tree(&mut c);
        let _ = c.wait();
    }
    if let Some(d) = dir {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// Stops the run playing now, if any, and deletes its folder. A run still starting sees the
/// newer id and ends itself.
pub fn stop(st: &Live) {
    let (child, dir) = {
        let mut r = st.run.lock().unwrap();
        r.id += 1;
        (r.child.take(), r.dir.take())
    };
    end(child, dir);
}

/// Stops the run `owner` asked for, playing or still starting; another player's run is left alone.
pub fn stop_owner(st: &Live, owner: &str) {
    let (child, dir) = {
        let mut r = st.run.lock().unwrap();
        if r.owner != owner {
            return;
        }
        r.id += 1;
        (r.child.take(), r.dir.take())
    };
    end(child, dir);
}

fn stop_if(st: &Live, id: u64) {
    let (child, dir) = {
        let mut r = st.run.lock().unwrap();
        if r.id != id {
            return;
        }
        r.id += 1;
        (r.child.take(), r.dir.take())
    };
    end(child, dir);
}

/// Claims the next run for `owner`, stopping any other: from here a stop by `owner` or a newer
/// claim ends the run, even before ffmpeg starts.
pub fn ticket(st: &Live, owner: &str) -> u64 {
    let (id, child, dir) = {
        let mut r = st.run.lock().unwrap();
        r.id += 1;
        r.owner = owner.to_string();
        (r.id, r.child.take(), r.dir.take())
    };
    end(child, dir);
    id
}

/// Why a run that lost its ticket ended: a stop, or a newer run.
fn replaced(r: &Run, owner: &str) -> String {
    if r.owner == owner && r.child.is_none() {
        STOPPED.into()
    } else {
        "Another stream started.".into()
    }
}

/// A run that has written its first segment.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub id: u64,
    /// The source time the run starts at: the player adds it to its own clock.
    pub at: f64,
    pub playlist: PathBuf,
}

/// Starts a run of `input` from `at` seconds in a fresh folder under `root`, stopping any other run,
/// and returns once the playlist lists a segment.
#[cfg(test)]
pub fn start(
    st: &Live,
    ffmpeg: &Path,
    root: &Path,
    input: &str,
    auth: Option<&str>,
    p: &StreamProbe,
    at: f64,
) -> Result<Started, String> {
    let id = ticket(st, "");
    run(st, id, "", ffmpeg, root, input, auth, p, at)
}

/// Starts the run ticket `id` claimed for `owner`. A stop or a newer ticket at any point ends it.
#[allow(clippy::too_many_arguments)]
pub fn run(
    st: &Live,
    id: u64,
    owner: &str,
    ffmpeg: &Path,
    root: &Path,
    input: &str,
    auth: Option<&str>,
    p: &StreamProbe,
    at: f64,
) -> Result<Started, String> {
    {
        let r = st.run.lock().unwrap();
        if r.id != id {
            return Err(replaced(&r, owner));
        }
    }
    let ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = root.join(format!("{ms}-{id}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(dir.join("ffmpeg.log")).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(ffmpeg);
    let child = own_group(&mut cmd)
        .args(run_args(input, auth, p, at, &dir))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .map_err(|e| e.to_string())?;
    let old = {
        let mut r = st.run.lock().unwrap();
        if r.id != id {
            let why = replaced(&r, owner);
            drop(r);
            end(Some(child), Some(dir));
            return Err(why);
        }
        (r.child.replace(child), r.dir.replace(dir.clone()))
    };
    end(old.0, old.1);
    let playlist = dir.join("index.m3u8");
    let t0 = Instant::now();
    while t0.elapsed() < FIRST_SEGMENT {
        if ready_to_play(&std::fs::read_to_string(&playlist).unwrap_or_default()) {
            return Ok(Started { id, at, playlist });
        }
        let ended = {
            let mut r = st.run.lock().unwrap();
            if r.id != id {
                return Err(replaced(&r, owner));
            }
            match r.child.as_mut() {
                None => return Err(STOPPED.into()),
                Some(c) => !matches!(c.try_wait(), Ok(None)),
            }
        };
        if ended && segments(&playlist) > 0 {
            return Ok(Started { id, at, playlist });
        }
        if ended {
            let why = last_line(&dir.join("ffmpeg.log"));
            stop_if(st, id);
            return Err(format!("ffmpeg could not convert this stream: {why}"));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    // A slow stream with a segment or two still plays; WebKit reads the playlist again as it grows.
    if segments(&playlist) > 0 {
        return Ok(Started { id, at, playlist });
    }
    stop_if(st, id);
    Err("The stream sent nothing to convert within 30 seconds.".into())
}

/// Run folders are a cache: drop any older than a day.
pub fn clean(root: &Path) {
    for d in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let old = d
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok());
        if old > Some(DAY) {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("remux-live"))
}

/// The asset URL of a run's playlist. Tauri's asset handler drops one leading slash and decodes the
/// rest, so only the first slash is encoded and the playlist's relative names (init.mp4, index0.m4s)
/// resolve next to it. convertFileSrc encodes every slash, which would send them to the root.
pub fn playlist_url(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    let (mut out, rest) = match p.strip_prefix('/') {
        Some(rest) => (String::from("asset://localhost/%2F"), rest.to_string()),
        None => (String::from("http://asset.localhost/"), p.clone()),
    };
    for b in rest.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// What the player opens for a run: the playlist's URL and the source time it starts at.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    url: String,
    at: f64,
    id: u64,
}

#[tauri::command]
pub async fn remux_start(
    app: tauri::AppHandle,
    url: String,
    user: Option<String>,
    pass: Option<String>,
    at: f64,
    owner: String,
) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<Live>();
        // The claim comes before the probe, so a close while the server is slow ends this run.
        let id = ticket(&st, &owner);
        let auth = basic(&user.unwrap_or_default(), &pass.unwrap_or_default());
        let p = probe_cached(&app.state::<Probes>(), &url, auth.as_deref())?;
        let ffmpeg = find_tool("ffmpeg").ok_or(NEEDS_FFMPEG)?;
        let s = run(
            &st,
            id,
            &owner,
            &ffmpeg,
            &root(&app)?,
            &url,
            auth.as_deref(),
            &p,
            at.max(0.0),
        )?;
        Ok(Opened {
            url: playlist_url(&s.playlist),
            at: s.at,
            id: s.id,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops `owner`'s run off the main thread: killing ffmpeg and deleting a long run's segments takes time.
#[tauri::command]
pub async fn remux_stop(app: tauri::AppHandle, owner: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || stop_owner(&app.state::<Live>(), &owner))
        .await;
}

#[cfg(test)]
mod tests {
    use super::super::playback::fixtures::*;
    use super::super::playback::probe;
    use super::*;

    const LIMIT: Duration = Duration::from_secs(6);

    /// "h264,avc1 ac3,ac-3": each stream's codec and tag, once each.
    fn codecs_of(ffprobe: &Path, playlist: &Path) -> String {
        let out = Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name,codec_tag_string",
            ])
            .args(["-of", "csv=p=0"])
            .arg(playlist)
            .output()
            .unwrap();
        let mut seen: Vec<String> = vec![];
        for l in String::from_utf8_lossy(&out.stdout).lines() {
            let l = l.trim().trim_end_matches(',').to_string();
            if !l.is_empty() && !seen.contains(&l) {
                seen.push(l);
            }
        }
        seen.join(" ")
    }

    fn alive(c: &Live) -> Option<u32> {
        c.run.lock().unwrap().child.as_ref().map(|c| c.id())
    }

    fn gone_within(pid: u32, limit: Duration) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < limit {
            let up = Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status();
            if !up.is_ok_and(|s| s.success()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn run_args_copy_what_plays_and_convert_the_rest() {
        let p = StreamProbe {
            video: Some("hevc".into()),
            audio: Some("dts".into()),
            channels: 6,
            ..Default::default()
        };
        let a = run_args(
            "https://x/a.mkv",
            Some("Basic eA=="),
            &p,
            5400.0,
            Path::new("/c/r"),
        );
        let s = a.join(" ");
        assert!(s.starts_with("-nostdin -loglevel error -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -ss 5400.000 -headers"), "{s}");
        assert!(s.contains("-i https://x/a.mkv -map 0:V:0? -map 0:a:0? -c:v copy -tag:v hvc1 -c:a aac -b:a 384k -ac 6"), "{s}");
        assert!(s.ends_with("-sn -f hls -hls_segment_type fmp4 -hls_time 4 -hls_playlist_type event -hls_flags independent_segments -hls_fmp4_init_filename init.mp4 /c/r/index.m3u8"), "{s}");
        let p = StreamProbe {
            video: Some("h264".into()),
            audio: Some("ac3".into()),
            channels: 6,
            ..Default::default()
        };
        let s = run_args("/m/a.mkv", None, &p, 0.0, Path::new("/c/r")).join(" ");
        assert!(
            s.starts_with("-nostdin -loglevel error -i /m/a.mkv"),
            "a local file at 0 gets no -ss or reconnect: {s}"
        );
        assert!(s.contains("-c:v copy -c:a copy -sn"), "{s}");
        let p = StreamProbe {
            video: Some("mpeg4".into()),
            audio: Some("flac".into()),
            channels: 2,
            ..Default::default()
        };
        let s = run_args("/m/a.avi", None, &p, 0.0, Path::new("/c/r")).join(" ");
        assert!(s.contains("-c:a aac -b:a 384k -ac 2"), "{s}");
        if cfg!(target_os = "macos") {
            assert!(s.contains("-c:v h264_videotoolbox"), "{s}");
        }
    }

    // Cases 1 and 3: an MKV (h264, ac3) remuxes with both copied and plays its first segment in under 3 s;
    // an MP4 (h264, aac) is direct.
    #[test]
    fn mkv_over_http_remuxes_copying_both_and_starts_fast() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("case1");
        fixture(
            &ffmpeg,
            &dir.join("a.mkv"),
            60,
            24,
            &["-c:v", "libx264", "-g", "48", "-c:a", "ac3", "-ac", "6"],
        );
        fixture(
            &ffmpeg,
            &dir.join("c.mp4"),
            10,
            24,
            &["-c:v", "libx264", "-c:a", "aac"],
        );
        let base = serve(dir.clone(), false);
        let p = probe(&ffprobe, &format!("{base}/a.mkv"), None, LIMIT).unwrap();
        assert_eq!(
            (p.direct, p.why.as_deref(), p.converts_audio),
            (false, Some("MKV"), false)
        );
        assert!((p.duration - 60.0).abs() < 1.0, "duration {}", p.duration);
        let c = probe(&ffprobe, &format!("{base}/c.mp4"), None, LIMIT).unwrap();
        assert!(c.direct && c.why.is_none(), "{c:?}");

        let st = Live::default();
        let t0 = Instant::now();
        let s = start(
            &st,
            &ffmpeg,
            &dir.join("runs"),
            &format!("{base}/a.mkv"),
            None,
            &p,
            0.0,
        )
        .unwrap();
        let took = t0.elapsed();
        assert!(
            took < Duration::from_secs(3),
            "first segment after {took:?}"
        );
        assert!(s.playlist.parent().unwrap().join("init.mp4").is_file());
        assert_eq!(codecs_of(&ffprobe, &s.playlist), "h264,avc1 ac3,ac-3");
        stop(&st);
        let _ = std::fs::remove_dir_all(dir);
    }

    // Case 2: MP4 with HEVC (tagged hev1) and DTS: remux for the audio; video copied as hvc1, audio AAC.
    #[test]
    fn hevc_with_dts_copies_video_as_hvc1_and_converts_audio() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("case2");
        let hevc = [
            "-c:v",
            "libx265",
            "-tag:v",
            "hev1",
            "-x265-params",
            "log-level=error",
        ];
        fixture(
            &ffmpeg,
            &dir.join("b.mp4"),
            20,
            24,
            &[&hevc[..], &["-c:a", "dca", "-strict", "-2", "-ac", "2"]].concat(),
        );
        let base = serve(dir.clone(), false);
        let url = format!("{base}/b.mp4");
        let p = probe(&ffprobe, &url, None, LIMIT).unwrap();
        assert_eq!(
            (
                p.direct,
                p.why.as_deref(),
                p.converts_audio,
                p.converts_video
            ),
            (false, Some("DTS audio"), true, false)
        );
        let st = Live::default();
        let s = start(&st, &ffmpeg, &dir.join("runs"), &url, None, &p, 0.0).unwrap();
        assert_eq!(codecs_of(&ffprobe, &s.playlist), "hevc,hvc1 aac,mp4a");
        stop(&st);
        let _ = std::fs::remove_dir_all(dir);
    }

    // Cases 4, 5 and 8: a seek far ahead starts a new run with -ss in a fresh folder and stops the old one;
    // seeking back starts another; stopping leaves no ffmpeg within 1 s.
    #[test]
    fn a_seek_restarts_the_run_and_stop_ends_ffmpeg() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("case4");
        // 1 h 35 m at 1 frame a second, a keyframe every 4: sparse, so it is quick to make.
        fixture(
            &ffmpeg,
            &dir.join("long.mkv"),
            5700,
            1,
            &[
                "-c:v",
                "libx264",
                "-g",
                "4",
                "-preset",
                "ultrafast",
                "-c:a",
                "ac3",
                "-b:a",
                "64k",
                "-ac",
                "1",
            ],
        );
        let base = serve(dir.clone(), false);
        let url = format!("{base}/long.mkv");
        let p = probe(&ffprobe, &url, None, LIMIT).unwrap();
        assert!((p.duration - 5700.0).abs() < 2.0, "duration {}", p.duration);
        let st = Live::default();
        let root = dir.join("runs");
        let first = start(&st, &ffmpeg, &root, &url, None, &p, 0.0).unwrap();
        let pid0 = alive(&st).unwrap();

        let t0 = Instant::now();
        let far = start(&st, &ffmpeg, &root, &url, None, &p, 5400.0).unwrap();
        assert!(
            t0.elapsed() < Duration::from_secs(3),
            "seek run took {:?}",
            t0.elapsed()
        );
        assert_eq!(far.at, 5400.0);
        assert!(
            gone_within(pid0, Duration::from_secs(1)),
            "the first run's ffmpeg kept running"
        );
        assert!(!first.playlist.exists(), "the first run's folder was kept");
        assert_ne!(far.playlist.parent(), first.playlist.parent());

        let back = start(&st, &ffmpeg, &root, &url, None, &p, 20.0).unwrap();
        assert_eq!(back.at, 20.0);
        assert!(back.id > far.id && !far.playlist.exists());

        let pid = alive(&st).unwrap();
        stop(&st);
        assert!(
            gone_within(pid, Duration::from_secs(1)),
            "ffmpeg still running 1 s after stop"
        );
        assert!(!back.playlist.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    // Rule 5: a library file the web view cannot play streams from its path, not a whole-file convert.
    #[test]
    fn a_library_file_streams_from_its_path_and_seeks() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("library");
        let file = dir.join("Movie (2024).mkv");
        fixture(
            &ffmpeg,
            &file,
            600,
            1,
            &[
                "-c:v",
                "libx264",
                "-g",
                "4",
                "-preset",
                "ultrafast",
                "-c:a",
                "ac3",
                "-b:a",
                "64k",
                "-ac",
                "1",
            ],
        );
        let path = file.to_string_lossy().into_owned();
        let p = probe(&ffprobe, &path, None, LIMIT).unwrap();
        assert!(!p.direct && (p.duration - 600.0).abs() < 2.0, "{p:?}");
        assert!(!run_args(&path, None, &p, 0.0, &dir).contains(&"-reconnect".to_string()));
        let st = Live::default();
        let t0 = Instant::now();
        let s = start(&st, &ffmpeg, &dir.join("runs"), &path, None, &p, 300.0).unwrap();
        assert!(
            t0.elapsed() < Duration::from_secs(3),
            "took {:?}",
            t0.elapsed()
        );
        assert_eq!(s.at, 300.0);
        assert!(ready_to_play(
            &std::fs::read_to_string(&s.playlist).unwrap()
        ));
        stop(&st);
        let _ = std::fs::remove_dir_all(dir);
    }

    // A Kodi or library FLAC with cover art: only the audio is remuxed (review r2 S1 of #154).
    #[test]
    fn an_audio_file_with_cover_art_remuxes_its_audio_only() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("cover");
        let file = dir.join("Track.flac");
        let ok = std::process::Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=600",
            ])
            .args(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1"])
            .args([
                "-map",
                "0:a",
                "-map",
                "1:v",
                "-frames:v",
                "1",
                "-c:a",
                "flac",
                "-c:v",
                "png",
            ])
            .args(["-disposition:v:0", "attached_pic"])
            .arg(&file)
            .status()
            .unwrap();
        assert!(ok.success());
        let path = file.to_string_lossy().into_owned();
        let p = probe(&ffprobe, &path, None, LIMIT).unwrap();
        let st = Live::default();
        let s = start(&st, &ffmpeg, &dir.join("runs"), &path, None, &p, 0.0).unwrap();
        let init = s.playlist.with_file_name("init.mp4");
        let out = std::process::Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
            ])
            .arg(&init)
            .output()
            .unwrap();
        stop(&st);
        let kinds = String::from_utf8_lossy(&out.stdout).to_string();
        assert_eq!(kinds.trim(), "audio", "streams in the run: {kinds:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_that_cannot_read_its_input_says_why() {
        let Some((ffmpeg, _)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("bad");
        let st = Live::default();
        let p = StreamProbe {
            video: Some("h264".into()),
            ..Default::default()
        };
        let e = start(
            &st,
            &ffmpeg,
            &dir,
            &dir.join("missing.mkv").to_string_lossy(),
            None,
            &p,
            0.0,
        )
        .unwrap_err();
        assert!(
            e.starts_with("ffmpeg could not convert this stream: "),
            "{e}"
        );
        assert!(alive(&st).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    // Case 8, while starting: the player closes before the first segment; the start gives up at once.
    // Review F1: a player that closes while the probe is still running (before ffmpeg starts) leaves
    // no ffmpeg behind and no folder.
    #[test]
    fn a_run_answers_at_three_segments_or_at_the_end() {
        let seg = |n: usize| {
            (0..n)
                .map(|i| format!("#EXTINF:4.0,\nindex{i}.m4s\n"))
                .collect::<String>()
        };
        let head = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"init.mp4\"\n";
        assert!(!ready_to_play(head));
        assert!(!ready_to_play(&format!("{head}{}", seg(1))));
        assert!(!ready_to_play(&format!("{head}{}", seg(2))));
        assert!(ready_to_play(&format!("{head}{}", seg(3))));
        assert!(ready_to_play(&format!("{head}{}#EXT-X-ENDLIST\n", seg(1))));
        assert!(!ready_to_play(&format!("{head}#EXT-X-ENDLIST\n")));
    }

    #[test]
    fn a_close_before_ffmpeg_starts_leaves_nothing_running() {
        let Some((ffmpeg, _)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("closeearly");
        fixture(
            &ffmpeg,
            &dir.join("a.mkv"),
            10,
            24,
            &["-c:v", "libx264", "-c:a", "ac3"],
        );
        let base = serve(dir.clone(), false);
        let st = Live::default();
        let p = StreamProbe {
            video: Some("h264".into()),
            audio: Some("ac3".into()),
            ..Default::default()
        };
        let id = ticket(&st, "p1");
        stop_owner(&st, "p1");
        let root = dir.join("runs");
        let e = run(
            &st,
            id,
            "p1",
            &ffmpeg,
            &root,
            &format!("{base}/a.mkv"),
            None,
            &p,
            0.0,
        );
        assert_eq!(e.unwrap_err(), STOPPED);
        assert!(alive(&st).is_none());
        assert!(!root.exists() || std::fs::read_dir(&root).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    // Review F6: the old player's close, landing after the new player's start, leaves the new run alone.
    #[test]
    fn a_closing_player_stops_only_its_own_run() {
        let Some((ffmpeg, _)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("owners");
        fixture(
            &ffmpeg,
            &dir.join("a.mkv"),
            30,
            24,
            &["-c:v", "libx264", "-c:a", "ac3"],
        );
        let base = serve(dir.clone(), false);
        let (st, root, url) = (Live::default(), dir.join("runs"), format!("{base}/a.mkv"));
        let p = StreamProbe {
            video: Some("h264".into()),
            audio: Some("ac3".into()),
            ..Default::default()
        };
        let one = ticket(&st, "p1");
        run(&st, one, "p1", &ffmpeg, &root, &url, None, &p, 0.0).unwrap();
        let two = ticket(&st, "p2");
        let s = run(&st, two, "p2", &ffmpeg, &root, &url, None, &p, 0.0).unwrap();
        let pid = alive(&st).unwrap();
        stop_owner(&st, "p1");
        assert_eq!(alive(&st), Some(pid));
        assert!(s.playlist.is_file());
        stop_owner(&st, "p2");
        assert!(gone_within(pid, Duration::from_secs(1)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_stop_while_a_run_starts_ends_it() {
        let Some((ffmpeg, _)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("stopstart");
        let base = serve(dir.clone(), true);
        let st = std::sync::Arc::new(Live::default());
        let p = StreamProbe {
            video: Some("h264".into()),
            ..Default::default()
        };
        let (st2, root, url) = (st.clone(), dir.join("runs"), format!("{base}/a.mkv"));
        let t = std::thread::spawn(move || start(&st2, &ffmpeg, &root, &url, None, &p, 0.0));
        let t0 = Instant::now();
        let pid = loop {
            if let Some(pid) = alive(&st) {
                break pid;
            }
            assert!(t0.elapsed() < Duration::from_secs(3), "no run started");
            std::thread::sleep(Duration::from_millis(10));
        };
        stop(&st);
        assert!(gone_within(pid, Duration::from_secs(1)));
        assert_eq!(t.join().unwrap().unwrap_err(), STOPPED);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn playlist_urls_keep_slashes_so_segment_names_resolve() {
        let u = playlist_url(Path::new(
            "/Users/me/Library/Caches/dev.flick/remux-live/17-2/index.m3u8",
        ));
        assert_eq!(
            u,
            "asset://localhost/%2FUsers/me/Library/Caches/dev.flick/remux-live/17-2/index.m3u8"
        );
        assert_eq!(
            playlist_url(Path::new("/a b/ü/index.m3u8")),
            "asset://localhost/%2Fa%20b/%C3%BC/index.m3u8"
        );
    }

    #[test]
    fn clean_drops_only_folders_older_than_a_day() {
        let dir = scratch("clean");
        let (old, new) = (dir.join("old"), dir.join("new"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        let ok = Command::new("touch")
            .args(["-t", "200001010000"])
            .arg(&old)
            .status()
            .unwrap();
        assert!(ok.success());
        clean(&dir);
        assert!(!old.exists() && new.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
