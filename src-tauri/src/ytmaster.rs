// YouTube's own HLS master for a `flick-tool:ytdlp/` stream (SPEC-youtube-play rules 1 to 3).
// yt-dlp finds the master's address and the web view plays it directly: no ffmpeg runs, and every
// part of a long video can be sought. A lookup takes about 7 s, so the title page starts it early
// (`prefetch`) and Play takes the cached answer, or waits for the lookup already running.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Url;

/// Formats YouTube serves as HLS. Asking for one makes yt-dlp print the master they all come from.
pub const FORMAT: &str = "bv*[protocol^=m3u8]";
const HOST: &str = "manifest.googlevideo.com";
/// How long an answer is kept at most, and how long before the URL's own expiry it is dropped.
const KEEP: Duration = Duration::from_secs(5 * 3600);
const MARGIN: u64 = 600;
/// Lookups that run at once, and pages that may wait for one.
const WORKERS: usize = 2;
const WAITING: usize = 8;

#[derive(Clone, Debug, PartialEq)]
pub struct Master {
    pub url: String,
    pub live: bool,
    pub duration: Option<f64>,
}

/// One lookup's answer: a master, None when the video has none to play (the fallback plays it), or yt-dlp's error.
pub type Found = Result<Option<Master>, String>;
pub type Find = Arc<dyn Fn(&str) -> Found + Send + Sync>;

type Slot = Arc<(Mutex<Option<Found>>, Condvar)>;

enum Entry {
    Ready(Option<Master>, Instant),
    Pending(Slot),
}

#[derive(Default)]
pub struct Masters {
    map: Mutex<HashMap<String, Entry>>,
    /// Pages waiting for a lookup, newest last, and how many lookups run.
    queue: Mutex<(Vec<String>, usize)>,
}

/// yt-dlp's arguments for one page: the master's address, whether it is live, and its length.
pub fn args(page: &str) -> Vec<&str> {
    vec![
        "--ignore-config",
        "--no-warnings",
        "--no-playlist",
        "-f",
        FORMAT,
        "-O",
        "manifest_url",
        "-O",
        "is_live",
        "-O",
        "duration",
        "--",
        page,
    ]
}

/// What yt-dlp printed. A master on any host but YouTube's own, or none at all, means the fallback.
pub fn parse(ok: bool, out: &str, err: &str) -> Found {
    if !ok {
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("failed")
            .trim();
        if last.contains("Requested format is not available") {
            return Ok(None);
        }
        return Err(format!("yt-dlp: {last}"));
    }
    let mut lines = out.lines().map(str::trim);
    let url = lines.next().unwrap_or("");
    let live = lines.next() == Some("True");
    let duration = lines.next().and_then(|d| d.parse().ok());
    let ours = Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some(HOST));
    Ok(ours.then(|| Master {
        url: url.into(),
        live,
        duration,
    }))
}

/// Time left before the URL's `expire/<unix seconds>/`, less ten minutes; zero once that has passed.
fn left(url: &str) -> Option<Duration> {
    let at: u64 = url
        .split("/expire/")
        .nth(1)?
        .split('/')
        .next()?
        .parse()
        .ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(Duration::from_secs(
        at.saturating_sub(MARGIN).saturating_sub(now),
    ))
}

fn until(m: &Option<Master>, now: Instant) -> Instant {
    now + m
        .as_ref()
        .and_then(|m| left(&m.url))
        .map_or(KEEP, |l| l.min(KEEP))
}

fn wait(slot: &Slot) -> Found {
    let mut g = slot.0.lock().unwrap();
    while g.is_none() {
        g = slot.1.wait(g).unwrap();
    }
    g.clone().unwrap()
}

impl Masters {
    /// The master for `page`: the cached one while it is good, the lookup already running, or a new one.
    /// `fresh` drops the cached one first (the player looks again after the stream failed).
    pub fn get(&self, page: &str, fresh: bool, find: &dyn Fn(&str) -> Found) -> Found {
        let running = {
            let mut map = self.map.lock().unwrap();
            match map.get(page) {
                Some(Entry::Ready(m, t)) if !fresh && *t > Instant::now() => return Ok(m.clone()),
                Some(Entry::Pending(s)) => Some(s.clone()),
                _ => {
                    map.insert(page.into(), Entry::Pending(Slot::default()));
                    None
                }
            }
        };
        if let Some(s) = running {
            return wait(&s);
        }
        let found = find(page);
        let slot = {
            let mut map = self.map.lock().unwrap();
            let slot = match map.remove(page) {
                Some(Entry::Pending(s)) => Some(s),
                _ => None,
            };
            if let Ok(m) = &found {
                map.insert(
                    page.into(),
                    Entry::Ready(m.clone(), until(m, Instant::now())),
                );
            }
            slot
        };
        if let Some(s) = slot {
            *s.0.lock().unwrap() = Some(found.clone());
            s.1.notify_all();
        }
        found
    }

    fn known(&self, page: &str) -> bool {
        match self.map.lock().unwrap().get(page) {
            Some(Entry::Pending(_)) => true,
            Some(Entry::Ready(_, t)) => *t > Instant::now(),
            None => false,
        }
    }

    /// Looks `page` up in the background unless it is known. At most two run; the newest page waiting goes next.
    pub fn prefetch(self: &Arc<Self>, page: &str, find: Find) {
        if self.known(page) {
            return;
        }
        let mut q = self.queue.lock().unwrap();
        q.0.retain(|p| p != page);
        q.0.push(page.into());
        if q.0.len() > WAITING {
            q.0.remove(0);
        }
        if q.1 >= WORKERS {
            return;
        }
        q.1 += 1;
        drop(q);
        let me = self.clone();
        std::thread::spawn(move || loop {
            let next = {
                let mut q = me.queue.lock().unwrap();
                match q.0.pop() {
                    Some(p) => p,
                    None => {
                        q.1 -= 1;
                        return;
                    }
                }
            };
            let _ = me.get(&next, false, &*find);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PAGE: &str = "https://www.youtube.com/watch?v=7xTGNNLPyMI";

    fn master(expire: u64) -> String {
        format!("https://{HOST}/api/manifest/hls_variant/expire/{expire}/ei/x/file/index.m3u8")
    }
    fn soon() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 6 * 3600
    }
    /// A lookup that takes `ms` and counts its calls.
    fn slow(ms: u64, url: String, calls: Arc<AtomicUsize>) -> Find {
        Arc::new(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(ms));
            Ok(Some(Master {
                url: url.clone(),
                live: false,
                duration: Some(12_660.0),
            }))
        })
    }

    #[test]
    fn reads_the_master_and_refuses_any_other_host() {
        let url = master(soon());
        let m = parse(true, &format!("{url}\nFalse\n12660\n"), "")
            .unwrap()
            .unwrap();
        assert_eq!(
            m,
            Master {
                url,
                live: false,
                duration: Some(12_660.0)
            }
        );
        assert_eq!(parse(true, "NA\nFalse\n60\n", ""), Ok(None));
        assert_eq!(
            parse(
                true,
                "https://evil.example/api/manifest/index.m3u8\nFalse\n60\n",
                ""
            ),
            Ok(None)
        );
        assert_eq!(
            parse(
                true,
                "http://manifest.googlevideo.com/index.m3u8\nFalse\n60\n",
                ""
            ),
            Ok(None)
        );
        let live = parse(true, &format!("{}\nTrue\nNA\n", master(soon())), "")
            .unwrap()
            .unwrap();
        assert!(live.live && live.duration.is_none());
        let none = "ERROR: [youtube] x: Requested format is not available. Use --list-formats for a list of available formats";
        assert_eq!(parse(false, "", none), Ok(None));
        assert_eq!(
            parse(false, "", "ERROR: [youtube] x: Video unavailable\n"),
            Err("yt-dlp: ERROR: [youtube] x: Video unavailable".into())
        );
    }

    #[test]
    fn play_after_the_title_page_looked_it_up_does_not_wait() {
        let (m, calls) = (Arc::new(Masters::default()), Arc::new(AtomicUsize::new(0)));
        let find = slow(700, master(soon()), calls.clone());
        m.prefetch(PAGE, find.clone());
        std::thread::sleep(Duration::from_millis(800));
        let t = Instant::now();
        assert!(m.get(PAGE, false, &*find).unwrap().is_some());
        assert!(
            t.elapsed() < Duration::from_millis(50),
            "Play waited {:?}",
            t.elapsed()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn two_plays_at_once_share_one_lookup() {
        let (m, calls) = (Arc::new(Masters::default()), Arc::new(AtomicUsize::new(0)));
        let find = slow(300, master(soon()), calls.clone());
        m.prefetch(PAGE, find.clone());
        let plays: Vec<_> = (0..2)
            .map(|_| {
                let (m, f) = (m.clone(), find.clone());
                std::thread::spawn(move || m.get(PAGE, false, &*f))
            })
            .collect();
        for p in plays {
            assert!(p.join().unwrap().unwrap().is_some());
        }
        m.prefetch(PAGE, find.clone());
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_expired_master_is_looked_up_again_and_fresh_skips_the_cache() {
        let (m, calls) = (Masters::default(), Arc::new(AtomicUsize::new(0)));
        let old = slow(0, master(1_000), calls.clone());
        m.get(PAGE, false, &*old).unwrap();
        m.get(PAGE, false, &*old).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2, "a stale URL was reused");
        let (m, calls) = (Masters::default(), Arc::new(AtomicUsize::new(0)));
        let good = slow(0, master(soon()), calls.clone());
        m.get(PAGE, false, &*good).unwrap();
        m.get(PAGE, false, &*good).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        m.get(PAGE, true, &*good).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn keeps_an_answer_five_hours_at_most_and_ten_minutes_short_of_expiry() {
        let now = Instant::now();
        let m = |e: u64| {
            Some(Master {
                url: master(e),
                live: false,
                duration: None,
            })
        };
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(until(&m(secs + 6 * 3600), now), now + KEEP);
        let t = until(&m(secs + 3600), now) - now;
        assert!(
            t <= Duration::from_secs(3000) && t > Duration::from_secs(2990),
            "{t:?}"
        );
        assert_eq!(until(&m(1_000), now), now);
        assert_eq!(until(&None, now), now + KEEP);
    }

    #[test]
    fn at_most_two_lookups_run_and_the_newest_page_goes_next() {
        let m = Arc::new(Masters::default());
        let order = Arc::new(Mutex::new(Vec::<String>::new()));
        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let find: Find = {
            let (order, running, most) = (order.clone(), running.clone(), most.clone());
            Arc::new(move |p: &str| {
                let n = running.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(n, Ordering::SeqCst);
                order.lock().unwrap().push(p.to_string());
                std::thread::sleep(Duration::from_millis(150));
                running.fetch_sub(1, Ordering::SeqCst);
                Ok(None)
            })
        };
        for p in ["a", "b", "c", "d"] {
            m.prefetch(p, find.clone());
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(most.load(Ordering::SeqCst), 2);
        assert_eq!(*order.lock().unwrap(), ["a", "b", "d", "c"]);
    }
}
