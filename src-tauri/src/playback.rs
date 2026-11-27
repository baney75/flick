// Streams the web view cannot open (SPEC-playback): an MKV, DTS or TrueHD audio, HEVC tagged hev1.
// `probe_stream` reads at most 5 MB of a stream within 6 seconds and says whether the web view plays it
// as it is (direct) or needs the live remux, and why ("MKV", "DTS audio"). Results are kept for the session.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

use super::ytdlp::{kill_tree, own_group};
use super::{basic, find_tool, input_args};

const PROBE_LIMIT: Duration = Duration::from_secs(6);
pub const SLOW_SERVER: &str = "The server did not answer within 6 seconds.";

/// Audio fMP4 HLS carries that the web view plays: copied as is. Anything else becomes AAC.
pub const COPY_AUDIO: &[&str] = &["aac", "mp3", "alac", "ac3", "eac3"];
/// What the web view plays without help (the table `run_probe` uses).
const DIRECT_VIDEO: &[&str] = &["h264", "hevc", "vp9", "vp8", "av1"];
const DIRECT_AUDIO: &[&str] = &[
    "aac",
    "mp3",
    "alac",
    "flac",
    "opus",
    "vorbis",
    "pcm_s16le",
    "pcm_s24le",
    "ac3",
    "eac3",
];

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbe {
    /// Seconds, 0 when the source does not say.
    pub duration: f64,
    pub container: String,
    pub video: Option<String>,
    pub audio: Option<String>,
    pub channels: u32,
    /// The web view plays it as it is.
    pub direct: bool,
    /// Why it needs the remux, in a few words ("MKV", "DTS audio"); None when direct.
    pub why: Option<String>,
    /// What a remux run does: transcode the video to H.264, or the audio to AAC.
    pub converts_video: bool,
    pub converts_audio: bool,
    /// False when ffprobe is missing: nothing was checked and the player plays it as it is.
    pub checked: bool,
}

/// The extension of a path or URL, without its query or fragment.
fn ext_of(input: &str) -> String {
    let p = input.split(['?', '#']).next().unwrap_or(input);
    Path::new(p)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn audio_name(c: &str) -> String {
    match c {
        "dts" => "DTS".into(),
        "truehd" => "TrueHD".into(),
        "mlp" => "MLP".into(),
        "wmav2" | "wmapro" => "WMA".into(),
        c if c.starts_with("pcm_") => "PCM".into(),
        c => c.to_ascii_uppercase(),
    }
}

fn video_name(c: &str) -> String {
    match c {
        "mpeg4" => "MPEG-4".into(),
        "mpeg2video" => "MPEG-2".into(),
        "mpeg1video" => "MPEG-1".into(),
        "vc1" => "VC-1".into(),
        "msmpeg4v3" => "DivX".into(),
        c => c.to_ascii_uppercase(),
    }
}

/// The container's problem, or None when the web view opens it.
fn container_why(
    format: &str,
    ext: &str,
    video: Option<&str>,
    audio: Option<&str>,
) -> Option<String> {
    let f = format;
    let plays = ["hls", "mp3", "aac", "wav", "flac", "aiff"];
    if f.contains("mp4") || f.contains("mov") || plays.contains(&f) {
        return None;
    }
    if f.contains("matroska") {
        // ffprobe names WebM and MKV alike: WebM holds only WebM's own codecs.
        let webm = video.is_none_or(|v| ["vp8", "vp9", "av1"].contains(&v))
            && audio.is_none_or(|a| ["opus", "vorbis"].contains(&a));
        return (ext == "mkv" || !webm).then(|| "MKV".into());
    }
    Some(
        match f.split(',').next().unwrap_or(f) {
            "avi" => "AVI",
            "mpegts" => "MPEG-TS",
            "asf" => "WMV",
            "flv" => "FLV",
            "mpeg" => "MPEG",
            "ogg" => "Ogg",
            other => return Some(other.to_ascii_uppercase()),
        }
        .into(),
    )
}

/// ffprobe's JSON for `input`, read as direct or remux.
pub fn verdict(j: &serde_json::Value, input: &str) -> StreamProbe {
    let mut p = StreamProbe {
        container: j["format"]["format_name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        duration: j["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        checked: true,
        ..Default::default()
    };
    let mut tag = String::new();
    for s in j["streams"].as_array().into_iter().flatten() {
        let codec = s["codec_name"].as_str().unwrap_or("").to_string();
        match s["codec_type"].as_str() {
            Some("video") if p.video.is_none() && codec != "mjpeg" && codec != "png" => {
                tag = s["codec_tag_string"].as_str().unwrap_or("").to_string();
                p.video = Some(codec);
            }
            Some("audio") if p.audio.is_none() => {
                p.channels = s["channels"].as_u64().unwrap_or(2) as u32;
                p.audio = Some(codec);
            }
            _ => {}
        }
    }
    let (v, a) = (p.video.as_deref(), p.audio.as_deref());
    let mp4 = p.container.contains("mp4") || p.container.contains("mov");
    p.why = container_why(&p.container, &ext_of(input), v, a)
        .or_else(|| {
            a.filter(|a| !DIRECT_AUDIO.contains(a))
                .map(|a| format!("{} audio", audio_name(a)))
        })
        .or_else(|| match v {
            // Safari plays HEVC in MP4 only when it is tagged hvc1.
            Some("hevc") if mp4 && tag == "hev1" => Some("HEVC tagged hev1".into()),
            Some(v) if !DIRECT_VIDEO.contains(&v) => Some(format!("{} video", video_name(v))),
            _ => None,
        });
    p.direct = p.why.is_none();
    p.converts_video = v.is_some_and(|v| v != "h264" && v != "hevc");
    p.converts_audio = a.is_some_and(|a| !COPY_AUDIO.contains(&a));
    p
}

/// Runs `cmd` with a deadline, killing it (and anything it started) when time runs out.
fn output_within(cmd: &mut Command, limit: Duration) -> Result<(bool, Vec<u8>, Vec<u8>), String> {
    let mut child = own_group(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let drain = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut b = vec![];
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut b);
            }
            b
        })
    };
    let out = drain(child.stdout.take().map(|r| Box::new(r) as _));
    let err = drain(child.stderr.take().map(|r| Box::new(r) as _));
    let start = Instant::now();
    let ok = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status.success(),
            None if start.elapsed() >= limit => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(SLOW_SERVER.into());
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    Ok((
        ok,
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    ))
}

/// Probes `input` with ffprobe, reading at most 5 MB, for at most `limit`.
pub fn probe(
    ffprobe: &Path,
    input: &str,
    auth: Option<&str>,
    limit: Duration,
) -> Result<StreamProbe, String> {
    let mut cmd = Command::new(ffprobe);
    cmd.args(["-v", "error", "-probesize", "5M", "-analyzeduration", "5M"])
        .args([
            "-show_entries",
            "format=format_name,duration:stream=codec_type,codec_name,codec_tag_string,channels",
        ])
        .args(["-of", "json"])
        .args(input_args(input, auth));
    let (ok, out, err) = output_within(&mut cmd, limit)?;
    let j: serde_json::Value = serde_json::from_slice(&out).unwrap_or_default();
    if !ok || j["format"].is_null() {
        let why = String::from_utf8_lossy(&err);
        let why = why
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no answer");
        return Err(format!("This stream could not be read: {}", why.trim()));
    }
    Ok(verdict(&j, input))
}

/// Probe results for this session, by input and login.
#[derive(Default)]
pub struct Probes(Mutex<HashMap<String, StreamProbe>>);

/// The probe of `input`, from this session's results when it has one. Without ffprobe nothing is
/// checked and the player plays the stream as it is.
pub fn probe_cached(st: &Probes, input: &str, auth: Option<&str>) -> Result<StreamProbe, String> {
    let key = format!("{input}\n{}", auth.unwrap_or(""));
    if let Some(p) = st.0.lock().unwrap().get(&key) {
        return Ok(p.clone());
    }
    let Some(ffprobe) = find_tool("ffprobe") else {
        return Ok(StreamProbe {
            direct: true,
            ..Default::default()
        });
    };
    let p = probe(&ffprobe, input, auth, PROBE_LIMIT)?;
    st.0.lock().unwrap().insert(key, p.clone());
    Ok(p)
}

#[tauri::command]
pub async fn probe_stream(
    app: tauri::AppHandle,
    url: String,
    user: Option<String>,
    pass: Option<String>,
) -> Result<StreamProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let auth = basic(&user.unwrap_or_default(), &pass.unwrap_or_default());
        probe_cached(&app.state::<Probes>(), &url, auth.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fixture media and a fixture server for the playback tests. Media is made with ffmpeg in the test.
#[cfg(test)]
pub mod fixtures {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Duration;

    pub fn tools() -> Option<(PathBuf, PathBuf)> {
        let t = (super::find_tool("ffmpeg")?, super::find_tool("ffprobe")?);
        Some(t)
    }

    pub fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flick-playback-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Makes a fixture with ffmpeg: a test pattern and a tone, `secs` long.
    pub fn fixture(ffmpeg: &Path, out: &Path, secs: u32, fps: u32, codecs: &[&str]) {
        let ok = Command::new(ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc=size=320x180:rate={fps}"))
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-t", &secs.to_string(), "-pix_fmt", "yuv420p"])
            .args(codecs)
            .arg(out)
            .status()
            .unwrap();
        assert!(ok.success(), "ffmpeg could not make {out:?}");
    }

    /// Serves `dir` over http on a free port with byte ranges; `hang` never answers at all.
    pub fn serve(dir: PathBuf, hang: bool) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let mut r = BufReader::new(s.try_clone().unwrap());
                    let (mut path, mut range) = (String::new(), None::<u64>);
                    let mut line = String::new();
                    while r.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                        if let Some(p) = line.strip_prefix("GET ") {
                            path = p
                                .split(' ')
                                .next()
                                .unwrap_or("")
                                .trim_start_matches('/')
                                .into();
                        }
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                            range = v.split('-').next().and_then(|n| n.trim().parse().ok());
                        }
                        line.clear();
                    }
                    if hang {
                        std::thread::sleep(Duration::from_secs(30));
                        return;
                    }
                    let Ok(data) = std::fs::read(dir.join(&path)) else {
                        let _ = (&s).write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        return;
                    };
                    let from = range.unwrap_or(0).min(data.len() as u64) as usize;
                    let head = match range {
                        Some(_) => format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{}\r\n",
                            data.len().saturating_sub(1),
                            data.len()
                        ),
                        None => "HTTP/1.1 200 OK\r\n".into(),
                    };
                    let head = format!("{head}Accept-Ranges: bytes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len() - from);
                    let mut w = &s;
                    let _ = w
                        .write_all(head.as_bytes())
                        .and_then(|_| w.write_all(&data[from..]));
                });
            }
        });
        format!("http://127.0.0.1:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn verdicts_name_what_needs_the_remux() {
        let j = |fmt: &str, v: &str, tag: &str, a: &str| {
            serde_json::json!({"format": {"format_name": fmt, "duration": "60.0"}, "streams": [
                {"codec_type": "video", "codec_name": v, "codec_tag_string": tag},
                {"codec_type": "audio", "codec_name": a, "channels": 6}]})
        };
        let mp4 = "mov,mp4,m4a,3gp,3g2,mj2";
        let why = |fmt, v, tag, a, url| verdict(&j(fmt, v, tag, a), url).why;
        assert_eq!(why(mp4, "h264", "avc1", "aac", "https://x/a.mp4"), None);
        assert_eq!(why(mp4, "hevc", "hvc1", "eac3", "https://x/a.mp4"), None);
        assert_eq!(
            why(mp4, "hevc", "hev1", "aac", "https://x/a.mp4").as_deref(),
            Some("HEVC tagged hev1")
        );
        assert_eq!(
            why(mp4, "h264", "avc1", "dts", "https://x/a.mp4").as_deref(),
            Some("DTS audio")
        );
        assert_eq!(
            why(mp4, "h264", "avc1", "truehd", "/m/a.mp4").as_deref(),
            Some("TrueHD audio")
        );
        assert_eq!(
            why(mp4, "mpeg4", "", "aac", "/m/a.mp4").as_deref(),
            Some("MPEG-4 video")
        );
        assert_eq!(
            why("matroska,webm", "h264", "", "aac", "https://x/a.mkv?t=1").as_deref(),
            Some("MKV")
        );
        // A debrid link has no extension: WebM codecs make it WebM, anything else MKV.
        assert_eq!(
            why("matroska,webm", "vp9", "", "opus", "https://x/dl/123"),
            None
        );
        assert_eq!(
            why("matroska,webm", "h264", "", "ac3", "https://x/dl/123").as_deref(),
            Some("MKV")
        );
        assert_eq!(
            why("avi", "mpeg4", "", "mp3", "/m/a.avi").as_deref(),
            Some("AVI")
        );
        assert_eq!(why("hls", "h264", "", "aac", "https://x/a.m3u8"), None);
        let p = verdict(&j("matroska,webm", "vc1", "", "dts"), "/m/a.mkv");
        assert!(p.converts_video && p.converts_audio && !p.direct && p.channels == 6);
        let p = verdict(&j("matroska,webm", "hevc", "", "eac3"), "/m/a.mkv");
        assert!(!p.converts_video && !p.converts_audio);
    }

    // Cases 1, 2 and 3 (the probe): an MKV is remux "MKV", an MP4 with DTS is remux "DTS audio",
    // an MP4 with h264 and aac is direct; each knows its duration.
    #[test]
    fn fixtures_over_http_probe_as_remux_or_direct() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("probe");
        let mkv = ["-c:v", "libx264", "-g", "48", "-c:a", "ac3", "-ac", "6"];
        fixture(&ffmpeg, &dir.join("a.mkv"), 60, 24, &mkv);
        let hevc = [
            "-c:v",
            "libx265",
            "-tag:v",
            "hev1",
            "-x265-params",
            "log-level=error",
        ];
        let dts = ["-c:a", "dca", "-strict", "-2", "-ac", "2"];
        fixture(
            &ffmpeg,
            &dir.join("b.mp4"),
            20,
            24,
            &[&hevc[..], &dts].concat(),
        );
        fixture(
            &ffmpeg,
            &dir.join("c.mp4"),
            10,
            24,
            &["-c:v", "libx264", "-c:a", "aac"],
        );
        let base = serve(dir.clone(), false);
        let p = |n: &str| probe(&ffprobe, &format!("{base}/{n}"), None, PROBE_LIMIT).unwrap();

        let a = p("a.mkv");
        assert_eq!((a.direct, a.why.as_deref()), (false, Some("MKV")));
        assert_eq!(
            (a.video.as_deref(), a.audio.as_deref(), a.channels),
            (Some("h264"), Some("ac3"), 6)
        );
        assert!(!a.converts_audio && !a.converts_video);
        assert!((a.duration - 60.0).abs() < 1.0, "duration {}", a.duration);
        let b = p("b.mp4");
        assert_eq!((b.direct, b.why.as_deref()), (false, Some("DTS audio")));
        assert!(b.converts_audio && !b.converts_video);
        let c = p("c.mp4");
        assert!(c.direct && c.why.is_none() && c.checked, "{c:?}");

        // The session keeps a result: the file gone from the server, the second probe still answers.
        let st = Probes::default();
        let url = format!("{base}/c.mp4");
        let first = probe_cached(&st, &url, None).unwrap();
        std::fs::remove_file(dir.join("c.mp4")).unwrap();
        assert!(probe(&ffprobe, &url, None, PROBE_LIMIT).is_err());
        assert_eq!(probe_cached(&st, &url, None).unwrap(), first);
        let _ = std::fs::remove_dir_all(dir);
    }

    // Case 7: a server that never answers fails the probe after 6 s, not later.
    #[test]
    fn a_server_that_never_answers_fails_the_probe_in_6_seconds() {
        let Some((_, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffprobe");
        };
        let base = serve(std::env::temp_dir(), true);
        let t0 = Instant::now();
        let e = probe(&ffprobe, &format!("{base}/a.mkv"), None, PROBE_LIMIT).unwrap_err();
        let took = t0.elapsed();
        assert_eq!(e, SLOW_SERVER);
        assert!(
            took >= PROBE_LIMIT && took < PROBE_LIMIT + Duration::from_secs(1),
            "took {took:?}"
        );
    }
}
