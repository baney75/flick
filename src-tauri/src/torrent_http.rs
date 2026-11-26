// The local server the player reads a torrent's file from (spec rule 17). It listens on 127.0.0.1
// only, every path starts with a random token, a request whose Host is not exactly
// 127.0.0.1:<port> gets 403 (so a web page that rebinds a name to 127.0.0.1 can't read it), and it
// serves only the files the engine registered: the chosen media file of each active torrent, with
// a media Content-Type and nosniff. No CORS headers, so other pages can't read the bytes.

use std::collections::HashMap;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};

/// A file the server can stream: its size, its name (for the media type), and a reader from an
/// offset. The torrent engine gives one per active torrent.
pub trait Source: Send + Sync {
    fn len(&self) -> u64;
    fn name(&self) -> &str;
    fn open(&self, start: u64) -> io::Result<Box<dyn Read + Send>>;
}

/// The Content-Type for a media file name; None for anything else, which is never served.
pub fn media_type(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        _ => return None,
    })
}

/// What a `Range` header asks for, against a file of `len` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Span {
    /// No usable range: the whole file, 200.
    All,
    /// Bytes `start..=end`, 206.
    Part(u64, u64),
    /// A range past the end, 416.
    Unsatisfiable,
}

/// One `bytes=` range: `a-b`, `a-` or `-n`. Several ranges or a malformed header serve the whole
/// file, as RFC 9110 allows.
pub fn parse_range(header: Option<&str>, len: u64) -> Span {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Span::All;
    };
    let Some((a, b)) = spec.trim().split_once('-').filter(|_| !spec.contains(',')) else {
        return Span::All;
    };
    let num = |s: &str| s.trim().parse::<u64>().ok();
    match (a.trim().is_empty(), num(a), num(b)) {
        (true, _, Some(n)) if n == 0 || len == 0 => Span::Unsatisfiable,
        (true, _, Some(n)) => Span::Part(len.saturating_sub(n), len - 1),
        (false, Some(start), _) if start >= len => Span::Unsatisfiable,
        (false, Some(start), None) if b.trim().is_empty() => Span::Part(start, len - 1),
        (false, Some(start), Some(end)) if end >= start => Span::Part(start, end.min(len - 1)),
        _ => Span::All,
    }
}

/// The registered key a request may read, or the status that refuses it.
pub fn admit(
    method: &str,
    host: Option<&str>,
    url: &str,
    port: u16,
    token: &str,
) -> Result<String, u16> {
    if host != Some(format!("127.0.0.1:{port}").as_str()) {
        return Err(403);
    }
    let path = url.split(['?', '#']).next().unwrap_or("");
    let Some((t, key)) = path.strip_prefix('/').and_then(|p| p.split_once('/')) else {
        return Err(403);
    };
    if !same(t.as_bytes(), token.as_bytes()) {
        return Err(403);
    }
    if method != "GET" && method != "HEAD" {
        return Err(405);
    }
    Ok(key.to_string())
}

/// Compares every byte, so the time taken says nothing about how much of a guess was right.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct Server {
    port: u16,
    token: String,
    files: Mutex<HashMap<String, Arc<dyn Source>>>,
}

impl Server {
    /// Starts listening on 127.0.0.1 at a free port, with a new random token.
    pub fn start() -> io::Result<Arc<Server>> {
        let http = tiny_http::Server::http("127.0.0.1:0").map_err(io::Error::other)?;
        let port = http
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or(io::ErrorKind::AddrNotAvailable)?;
        let mut raw = [0u8; 16];
        getrandom::fill(&mut raw).map_err(|e| io::Error::other(e.to_string()))?;
        let token = raw.iter().map(|b| format!("{b:02x}")).collect();
        let files = Mutex::default();
        let server = Arc::new(Server { port, token, files });
        let s = Arc::clone(&server);
        std::thread::spawn(move || {
            for req in http.incoming_requests() {
                let s = Arc::clone(&s);
                std::thread::spawn(move || s.answer(req));
            }
        });
        Ok(server)
    }

    fn files(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<dyn Source>>> {
        self.files.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Serves `source` under `key` and returns the URL the player opens. Refuses a non-media file.
    pub fn add(&self, key: &str, source: Arc<dyn Source>) -> Result<String, String> {
        if media_type(source.name()).is_none() {
            return Err("Flick only plays video and audio files from torrents.".into());
        }
        self.files().insert(key.to_string(), source);
        Ok(format!(
            "http://127.0.0.1:{}/{}/{key}",
            self.port, self.token
        ))
    }

    pub fn remove(&self, key: &str) {
        self.files().remove(key);
    }

    fn answer(&self, req: tiny_http::Request) {
        let header = |name: &'static str| {
            req.headers()
                .iter()
                .find(|h| h.field.equiv(name))
                .map(|h| h.value.as_str().to_string())
        };
        let (host, range) = (header("Host"), header("Range"));
        let method = req.method().as_str().to_string();
        let admitted = admit(&method, host.as_deref(), req.url(), self.port, &self.token);
        let source = admitted.and_then(|key| self.files().get(&key).cloned().ok_or(404));
        let result = match source {
            Ok(src) => respond(src.as_ref(), range.as_deref()),
            Err(code) => Err(code),
        };
        let sent = match result {
            Ok(r) => req.respond(r),
            Err(code) => req.respond(tiny_http::Response::empty(code)),
        };
        if let Err(e) = sent {
            eprintln!("torrent stream: {e}");
        }
    }
}

type Body = tiny_http::Response<Box<dyn Read + Send>>;

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("ascii header")
}

fn respond(src: &dyn Source, range: Option<&str>) -> Result<Body, u16> {
    let len = src.len();
    let mime = media_type(src.name()).ok_or(404u16)?;
    let mut headers = vec![
        header("Content-Type", mime),
        header("X-Content-Type-Options", "nosniff"),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-store"),
    ];
    let (status, start, count) = match parse_range(range, len) {
        Span::All => (200, 0, len),
        Span::Part(a, b) => {
            headers.push(header("Content-Range", &format!("bytes {a}-{b}/{len}")));
            (206, a, b - a + 1)
        }
        Span::Unsatisfiable => {
            headers.push(header("Content-Range", &format!("bytes */{len}")));
            let empty: Box<dyn Read + Send> = Box::new(io::empty());
            return Ok(tiny_http::Response::new(
                416.into(),
                headers,
                empty,
                Some(0),
                None,
            ));
        }
    };
    let reader = src.open(start).map_err(|_| 503u16)?;
    let body: Box<dyn Read + Send> = Box::new(reader.take(count));
    let size = usize::try_from(count).map_err(|_| 500u16)?;
    Ok(tiny_http::Response::new(
        status.into(),
        headers,
        body,
        Some(size),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    struct Mem(Vec<u8>, &'static str);

    impl Source for Mem {
        fn len(&self) -> u64 {
            self.0.len() as u64
        }
        fn name(&self) -> &str {
            self.1
        }
        fn open(&self, start: u64) -> io::Result<Box<dyn Read + Send>> {
            Ok(Box::new(io::Cursor::new(self.0[start as usize..].to_vec())))
        }
    }

    /// Sends a raw request and returns the status, the headers (lowercase names) and the body.
    fn get(port: u16, path: &str, extra: &str) -> (u16, String, Vec<u8>) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!("GET {path} HTTP/1.1\r\n{extra}Connection: close\r\n\r\n");
        c.write_all(req.as_bytes()).unwrap();
        let mut out = vec![];
        c.read_to_end(&mut out).unwrap();
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&out[..split]).to_lowercase();
        let status = head[9..12].parse().unwrap();
        (status, head, out[split + 4..].to_vec())
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), Span::All);
        assert_eq!(parse_range(Some("bytes=0-"), 100), Span::Part(0, 99));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Span::Part(10, 19));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), Span::Part(90, 99));
        assert_eq!(parse_range(Some("bytes=-30"), 100), Span::Part(70, 99));
        assert_eq!(parse_range(Some("bytes=-500"), 100), Span::Part(0, 99));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 100), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Span::All);
        assert_eq!(parse_range(Some("bytes=9-3"), 100), Span::All);
        assert_eq!(parse_range(Some("items=0-1"), 100), Span::All);
        assert_eq!(parse_range(Some("bytes=-5"), 0), Span::Unsatisfiable);
    }

    #[test]
    fn admits_only_the_token_the_exact_host_and_reads() {
        let ok = admit("GET", Some("127.0.0.1:5000"), "/tok/abc/0?x=1", 5000, "tok");
        assert_eq!(ok, Ok("abc/0".into()));
        assert!(admit("HEAD", Some("127.0.0.1:5000"), "/tok/abc/0", 5000, "tok").is_ok());
        assert_eq!(
            admit("GET", Some("localhost:5000"), "/tok/abc/0", 5000, "tok"),
            Err(403)
        );
        assert_eq!(
            admit("GET", Some("evil.test"), "/tok/abc/0", 5000, "tok"),
            Err(403)
        );
        assert_eq!(admit("GET", None, "/tok/abc/0", 5000, "tok"), Err(403));
        assert_eq!(
            admit("GET", Some("127.0.0.1:5000"), "/tak/abc/0", 5000, "tok"),
            Err(403)
        );
        assert_eq!(
            admit("GET", Some("127.0.0.1:5000"), "/tok", 5000, "tok"),
            Err(403)
        );
        assert_eq!(
            admit("POST", Some("127.0.0.1:5000"), "/tok/abc/0", 5000, "tok"),
            Err(405)
        );
        assert_eq!(media_type("Big Buck Bunny.MP4"), Some("video/mp4"));
        assert_eq!(media_type("setup.exe"), None);
        assert_eq!(media_type("README"), None);
    }

    #[test]
    fn serves_the_registered_file_by_range_and_nothing_else() {
        let s = Server::start().unwrap();
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let url = s
            .add("dd82/0", Arc::new(Mem(data.clone(), "bunny.mp4")))
            .unwrap();
        let path = url
            .strip_prefix(&format!("http://127.0.0.1:{}", s.port))
            .unwrap()
            .to_string();
        let host = format!("Host: 127.0.0.1:{}\r\n", s.port);

        let (code, head, body) = get(s.port, &path, &host);
        assert_eq!((code, body.len()), (200, 5000));
        assert!(head.contains("content-type: video/mp4"), "{head}");
        assert!(head.contains("x-content-type-options: nosniff"), "{head}");
        assert!(!head.contains("access-control-allow-origin"), "{head}");

        // The player's seek to the end: the last 1 KB.
        let (code, head, body) = get(s.port, &path, &format!("{host}Range: bytes=-1024\r\n"));
        assert_eq!(code, 206);
        assert!(
            head.contains("content-range: bytes 3976-4999/5000"),
            "{head}"
        );
        assert_eq!(body, data[3976..]);

        let (code, head, _) = get(s.port, &path, &format!("{host}Range: bytes=9000-\r\n"));
        assert_eq!(code, 416);
        assert!(head.contains("content-range: bytes */5000"), "{head}");

        let bad_host = format!("Host: localhost:{}\r\n", s.port);
        assert_eq!(get(s.port, &path, &bad_host).0, 403);
        assert_eq!(
            get(s.port, "/0123456789abcdef0123456789abcdef/dd82/0", &host).0,
            403
        );
        let other = path.replace("dd82/0", "dd82/1");
        assert_eq!(get(s.port, &other, &host).0, 404);
        s.remove("dd82/0");
        assert_eq!(get(s.port, &path, &host).0, 404, "a stopped torrent");

        assert!(s.add("x/0", Arc::new(Mem(vec![1], "run.sh"))).is_err());
        // Listening on 127.0.0.1 only: this computer's other addresses refuse the connection.
        let lan = if_addrs::get_if_addrs()
            .unwrap()
            .into_iter()
            .find(|i| !i.is_loopback());
        if let Some(i) = lan {
            let to = std::net::SocketAddr::new(i.ip(), s.port);
            let tried = TcpStream::connect_timeout(&to, std::time::Duration::from_secs(1));
            assert!(tried.is_err(), "reachable on {}", i.ip());
        }
    }
}
