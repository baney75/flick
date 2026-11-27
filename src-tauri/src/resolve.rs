// SPEC-playback-2 rule 1: an http(s) stream is opened once, here, before anything else reads it. A
// debrid addon link adds the torrent on its first GET and answers with a redirect only once the file is
// ready, often 10 to 30 s later, so this waits up to 90 s for the first byte. The probe, the remux and
// direct play then all read the final URL, so the slow resolve is paid once. A final URL is reused for
// 10 minutes: debrid links are signed and expire, so a later play resolves again.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use ureq::ResponseExt;

use super::basic;

pub const RESOLVE_LIMIT: Duration = Duration::from_secs(90);
/// How long a resolve is reused: long enough for a warm-up and Play, short of a debrid link expiring.
pub const FRESH: Duration = Duration::from_secs(600);
const MAX_REDIRECTS: u32 = 10;

pub fn no_answer() -> String {
    format!(
        "The server did not answer within {} seconds.",
        RESOLVE_LIMIT.as_secs()
    )
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// Where the redirects ended: every later read uses this.
    pub url: String,
    pub status: u16,
    pub content_type: Option<String>,
    /// The whole file's size: content-range's total, or a 200's content-length.
    pub length: Option<u64>,
    pub ranges: bool,
    pub redirects: usize,
    pub ms: u64,
}

/// One GET of `input` for its first byte, redirects followed. A 4xx or 5xx, or no answer within
/// `limit`, is the error the player shows. The body is never read: dropping the answer drops it.
pub fn resolve(input: &str, auth: Option<&str>, limit: Duration) -> Result<Resolved, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(MAX_REDIRECTS)
        .save_redirect_history(true)
        .redirect_auth_headers(ureq::config::RedirectAuthHeaders::SameHost)
        .http_status_as_error(false)
        .timeout_global(Some(limit))
        .build()
        .into();
    let t0 = Instant::now();
    let mut req = agent.get(input).header("Range", "bytes=0-0");
    if let Some(a) = auth {
        req = req.header("Authorization", a);
    }
    let r = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Timeout(_)) => return Err(no_answer()),
        Err(ureq::Error::Io(e)) if e.kind() == std::io::ErrorKind::TimedOut => {
            return Err(no_answer())
        }
        Err(ureq::Error::TooManyRedirects) => {
            return Err("The server sent too many redirects.".into())
        }
        Err(e) => return Err(format!("The server could not be reached ({e}).")),
    };
    let s = r.status();
    // 416: the server refuses the range, not the stream; a plain read still plays.
    if s.as_u16() >= 400 && s.as_u16() != 416 {
        let reason = s.canonical_reason().map(|w| format!(" {w}"));
        return Err(format!(
            "The server answered {}{}.",
            s.as_u16(),
            reason.unwrap_or_default()
        ));
    }
    let h = |k: &str| {
        r.headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let total = h("content-range").and_then(|v| v.rsplit('/').next()?.trim().parse().ok());
    let length = total.or_else(|| match s.as_u16() {
        200 => h("content-length")?.trim().parse().ok(),
        _ => None,
    });
    Ok(Resolved {
        url: r.get_uri().to_string(),
        status: s.as_u16(),
        content_type: h("content-type"),
        length,
        ranges: s.as_u16() == 206 || h("accept-ranges").is_some_and(|v| v.contains("bytes")),
        // The history lists the first request and every location after it.
        redirects: r
            .get_redirect_history()
            .map_or(0, |h| h.len().saturating_sub(1)),
        ms: t0.elapsed().as_millis() as u64,
    })
}

/// Recent resolves, by source URL and login, with when each was made.
#[derive(Default)]
pub struct Resolves(Mutex<HashMap<String, (Instant, Resolved)>>);

impl Resolves {
    /// The resolve of `key` made within FRESH, if any.
    fn fresh(&self, key: &str) -> Option<Resolved> {
        let m = self.0.lock().unwrap();
        m.get(key)
            .filter(|(at, _)| at.elapsed() < FRESH)
            .map(|(_, r)| r.clone())
    }
    fn keep(&self, key: String, r: &Resolved, at: Instant) {
        self.0.lock().unwrap().insert(key, (at, r.clone()));
    }
}

#[tauri::command]
pub async fn resolve_stream(
    app: tauri::AppHandle,
    url: String,
    user: Option<String>,
    pass: Option<String>,
) -> Result<Resolved, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let auth = basic(&user.unwrap_or_default(), &pass.unwrap_or_default());
        let key = format!("{url}\n{}", auth.as_deref().unwrap_or(""));
        let st = app.state::<Resolves>();
        if let Some(r) = st.fresh(&key) {
            return Ok(r);
        }
        let r = resolve(&url, auth.as_deref(), RESOLVE_LIMIT)?;
        st.keep(key, &r, Instant::now());
        Ok(r)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::super::live::{start, stop, Live};
    use super::super::playback::fixtures::*;
    use super::super::playback::{probe, PROBE_LIMIT};
    use super::*;

    const SLOW: Duration = Duration::from_secs(20);

    // Case 1: the addon answers after 20 s with a 302 to an MKV (h264 + ac3). It plays from the final
    // URL, its first segment under 25 s from Play, and the addon URL is fetched exactly once.
    #[test]
    fn a_slow_redirect_to_an_mkv_is_fetched_once_and_plays() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("slow-mkv");
        let mkv = ["-c:v", "libx264", "-g", "48", "-c:a", "ac3"];
        fixture(&ffmpeg, &dir.join("a.mkv"), 60, 24, &mkv);
        let s = serve_routes(dir.clone(), vec![("addon/1", redirect(SLOW, "a.mkv"))]);
        let t0 = Instant::now();
        let r = resolve(&format!("{}/addon/1", s.base), None, RESOLVE_LIMIT).unwrap();
        assert!(t0.elapsed() >= SLOW, "answered before the server did");
        assert_eq!(
            (r.url.clone(), r.redirects, r.status),
            (format!("{}/a.mkv", s.base), 1, 206)
        );
        assert!(r.ranges && r.length.is_some_and(|n| n > 1000), "{r:?}");
        let p = probe(&ffprobe, &r.url, None, PROBE_LIMIT).unwrap();
        assert_eq!(p.why.as_deref(), Some("MKV"));
        let st = Live::default();
        let run = start(&st, &ffmpeg, &dir.join("runs"), &r.url, None, &p, 0.0).unwrap();
        let took = t0.elapsed();
        assert!(run.playlist.is_file());
        assert!(
            took < Duration::from_secs(25),
            "first segment after {took:?}"
        );
        stop(&st);
        assert_eq!(s.hits("addon/1"), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    // Case 2: the same with a 302 to an MP4 (h264 + aac): direct from the final URL, addon hit once.
    #[test]
    fn a_slow_redirect_to_an_mp4_plays_directly_from_the_final_url() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("slow-mp4");
        fixture(
            &ffmpeg,
            &dir.join("c.mp4"),
            10,
            24,
            &["-c:v", "libx264", "-c:a", "aac"],
        );
        let s = serve_routes(dir.clone(), vec![("addon/2", redirect(SLOW, "c.mp4"))]);
        let r = resolve(&format!("{}/addon/2", s.base), None, RESOLVE_LIMIT).unwrap();
        assert_eq!(r.url, format!("{}/c.mp4", s.base));
        assert_eq!(r.content_type.as_deref(), Some("video/mp4"));
        let p = probe(&ffprobe, &r.url, None, PROBE_LIMIT).unwrap();
        assert!(p.direct, "{p:?}");
        assert_eq!(s.hits("addon/2"), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    // Case 3: a 404 after the redirect stops here with the server's words.
    #[test]
    fn a_404_after_a_redirect_says_so() {
        let dir = scratch("404");
        let s = serve_routes(
            dir.clone(),
            vec![("addon/3", redirect(Duration::ZERO, "gone.mkv"))],
        );
        let e = resolve(&format!("{}/addon/3", s.base), None, RESOLVE_LIMIT).unwrap_err();
        assert_eq!(e, "The server answered 404 Not Found.");
        let _ = std::fs::remove_dir_all(dir);
    }

    // Review F1 of #165: a resolve is reused for 10 minutes, then made again (debrid links expire).
    #[test]
    fn a_resolve_is_reused_for_ten_minutes_then_made_again() {
        assert_eq!(FRESH, Duration::from_secs(600));
        let st = Resolves::default();
        let r = Resolved {
            url: "https://cdn.example/a.mkv".into(),
            ..Default::default()
        };
        st.keep("k".into(), &r, Instant::now());
        assert_eq!(st.fresh("k"), Some(r.clone()));
        st.keep(
            "k".into(),
            &r,
            Instant::now() - FRESH - Duration::from_secs(1),
        );
        assert_eq!(st.fresh("k"), None);
        assert_eq!(st.fresh("other"), None);
    }

    // Review F5 of #165: a server that answers the range with 416 still resolves, as one without ranges.
    #[test]
    fn a_refused_range_still_resolves() {
        let dir = scratch("416");
        let s = serve_routes(dir.clone(), vec![("live/7", Route::RangeRefused)]);
        let r = resolve(&format!("{}/live/7", s.base), None, RESOLVE_LIMIT).unwrap();
        assert_eq!((r.status, r.ranges), (416, false));
        assert_eq!(r.url, format!("{}/live/7", s.base));
        let _ = std::fs::remove_dir_all(dir);
    }

    // Case 4: a server that never answers fails at the limit with the 90 s message (a short limit here).
    #[test]
    fn a_server_that_never_answers_fails_at_the_limit() {
        assert_eq!(RESOLVE_LIMIT, Duration::from_secs(90));
        let base = serve(std::env::temp_dir(), true);
        let t0 = Instant::now();
        let e = resolve(&format!("{base}/a.mkv"), None, Duration::from_secs(2)).unwrap_err();
        assert_eq!(e, "The server did not answer within 90 seconds.");
        let took = t0.elapsed();
        assert!(
            took >= Duration::from_secs(2) && took < Duration::from_secs(4),
            "took {took:?}"
        );
    }

    // Case 5: a valid 200 with content-type video/mp4 and garbage after it: resolve is fine, the
    // probe fails, and the player (tests/playback.test.ts) plays it directly instead of showing that.
    #[test]
    fn garbage_behind_a_valid_answer_resolves_and_fails_only_the_probe() {
        let Some((_, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffprobe");
        };
        let dir = scratch("garbage");
        let s = serve_routes(dir.clone(), vec![("dl/5", Route::Garbage)]);
        let r = resolve(&format!("{}/dl/5", s.base), None, RESOLVE_LIMIT).unwrap();
        assert_eq!(r.content_type.as_deref(), Some("video/mp4"));
        assert!(probe(&ffprobe, &r.url, None, PROBE_LIMIT).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    // Case 6: an MKV whose body stalls after the headers resolves at once and only the probe times
    // out (20 s, shortened here); playback.rs checks the safe profile the run then takes.
    #[test]
    fn a_stalled_body_resolves_at_once_and_only_the_probe_times_out() {
        let Some((_, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffprobe");
        };
        assert_eq!(PROBE_LIMIT, Duration::from_secs(20));
        let dir = scratch("stall");
        let s = serve_routes(dir.clone(), vec![("x.mkv", Route::StallBody)]);
        let r = resolve(&format!("{}/x.mkv", s.base), None, RESOLVE_LIMIT).unwrap();
        assert!(r.ms < 2000, "{r:?}");
        let t0 = Instant::now();
        assert!(probe(&ffprobe, &r.url, None, Duration::from_secs(2)).is_err());
        assert!(t0.elapsed() < Duration::from_secs(4));
        let _ = std::fs::remove_dir_all(dir);
    }
}
