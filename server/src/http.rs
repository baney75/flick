//! The HTTP transport: hyper on a small tokio runtime of its own, carrying each request to `answer`.
use crate::{answer, Reply, Req, State, Verb};
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use hyper::header::{AUTHORIZATION, CONTENT_LENGTH, RANGE};
use hyper::{body::Incoming, service::service_fn, Method, Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::future::Future;
use std::io::{self, Read};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::{watch, Semaphore};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// A client must send its request headers within this long.
    pub header_read: Duration,
    /// A write that makes no progress for this long drops the connection.
    pub write_stall: Duration,
    /// Connections past this many are closed as soon as they are accepted.
    pub connections: usize,
}

pub(crate) const LIMITS: Limits = Limits {
    header_read: Duration::from_secs(30),
    write_stall: Duration::from_secs(60),
    connections: 256,
};

const CHUNK: usize = 64 * 1024;
/// Threads for handlers and file reads. A paused stream holds none of them.
const BLOCKING_THREADS: usize = 64;

pub(crate) struct Transport {
    rt: Option<tokio::runtime::Runtime>,
    stop: watch::Sender<bool>,
    closed: std::sync::mpsc::Receiver<()>,
}

/// Serves `listener` until `stop`.
pub(crate) fn listen(
    listener: std::net::TcpListener,
    st: Arc<State>,
    limits: Limits,
) -> io::Result<Transport> {
    listener.set_nonblocking(true)?;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(BLOCKING_THREADS)
        .thread_name("flick-server")
        .enable_all()
        .build()?;
    let listener = {
        let _in = rt.enter();
        TcpListener::from_std(listener)
    };
    let listener = match listener {
        Ok(l) => l,
        Err(e) => {
            // Dropping a runtime on another runtime's thread panics; this never blocks.
            rt.shutdown_background();
            return Err(e);
        }
    };
    let (stop, stopped) = watch::channel(false);
    let (closed_tx, closed) = std::sync::mpsc::channel();
    rt.spawn(accept(listener, st, limits, stopped, closed_tx));
    Ok(Transport {
        rt: Some(rt),
        stop,
        closed,
    })
}

impl Transport {
    /// Closes the listener and every connection, and returns once the port is free. Safe to call
    /// from inside another runtime.
    pub(crate) fn stop(&mut self) {
        let Some(rt) = self.rt.take() else { return };
        let _ = self.stop.send(true);
        let _ = self.closed.recv_timeout(Duration::from_secs(2));
        rt.shutdown_background();
    }
}

async fn accept(
    listener: TcpListener,
    st: Arc<State>,
    limits: Limits,
    mut stopped: watch::Receiver<bool>,
    closed: std::sync::mpsc::Sender<()>,
) {
    let slots = Arc::new(Semaphore::new(limits.connections));
    loop {
        let stream = tokio::select! {
            _ = stopped.changed() => break,
            got = listener.accept() => match got {
                Ok((s, _)) => s,
                // Out of file handles, most likely: wait for some to close.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
        };
        // Past the cap the connection is closed at once, so a flood can't hold the server's memory.
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let (st, mut stopped) = (st.clone(), stopped.clone());
        tokio::spawn(async move {
            let _slot = slot;
            let _ = stream.set_nodelay(true);
            let io = TokioIo::new(Stalls::new(stream, limits.write_stall));
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                // Header names as tiny_http wrote them, so answers read the same as before.
                .title_case_headers(true)
                .header_read_timeout(limits.header_read)
                .serve_connection(io, service_fn(move |req| respond(st.clone(), req)));
            tokio::select! {
                _ = conn => {}
                _ = stopped.changed() => {}
            }
        });
    }
    drop(listener);
    let _ = closed.send(());
}

async fn respond(
    st: Arc<State>,
    req: Request<Incoming>,
) -> Result<Response<Stream>, std::convert::Infallible> {
    let get = |k| {
        req.headers()
            .get(k)
            .and_then(|v: &hyper::header::HeaderValue| v.to_str().ok())
            .map(str::to_string)
    };
    let ask = Req {
        verb: match *req.method() {
            Method::GET => Verb::Get,
            Method::HEAD => Verb::Head,
            Method::OPTIONS => Verb::Options,
            _ => Verb::Other,
        },
        target: req
            .uri()
            .path_and_query()
            .map_or("/", |p| p.as_str())
            .to_string(),
        authorization: get(AUTHORIZATION),
        range: get(RANGE),
    };
    let head = ask.verb == Verb::Head;
    // The handlers read files, scan folders and render thumbnails, so they run off the async threads.
    let reply = tokio::task::spawn_blocking(move || answer(&st, &ask))
        .await
        .unwrap_or_else(|_| Reply::json(500, serde_json::json!({"error":"server error"})));
    Ok(build(reply, head))
}

fn build(reply: Reply, head: bool) -> Response<Stream> {
    let mut res = Response::builder().status(reply.status);
    for (k, v) in &reply.headers {
        res = res.header(*k, v.as_str());
    }
    if reply.status != 204 {
        res = res.header(CONTENT_LENGTH, reply.len);
    }
    let body = if head || reply.len == 0 {
        Stream::empty()
    } else {
        Stream::read(reply.body, reply.len)
    };
    res.body(body).unwrap_or_else(|_| {
        let mut r = Response::new(Stream::empty());
        *r.status_mut() = hyper::StatusCode::INTERNAL_SERVER_ERROR;
        r
    })
}

type Reader = Box<dyn Read + Send>;

/// A body read from a blocking reader one chunk at a time, on the blocking pool, only when hyper
/// asks for the next chunk. A paused client holds the reader and no thread.
pub(crate) struct Stream {
    feed: Feed,
    left: u64,
}

enum Feed {
    Idle(Reader),
    Reading(tokio::task::JoinHandle<(Reader, io::Result<Bytes>)>),
    Done,
}

impl Stream {
    fn empty() -> Stream {
        Stream {
            feed: Feed::Done,
            left: 0,
        }
    }
    fn read(body: Reader, len: u64) -> Stream {
        Stream {
            feed: Feed::Idle(body),
            left: len,
        }
    }
}

impl Body for Stream {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        loop {
            match std::mem::replace(&mut self.feed, Feed::Done) {
                Feed::Done => return Poll::Ready(None),
                Feed::Idle(_) if self.left == 0 => return Poll::Ready(None),
                Feed::Idle(mut body) => {
                    let want = self.left.min(CHUNK as u64) as usize;
                    self.feed = Feed::Reading(tokio::task::spawn_blocking(move || {
                        let mut buf = vec![0; want];
                        let got = match body.read(&mut buf) {
                            Ok(0) => Err(io::ErrorKind::UnexpectedEof.into()),
                            Ok(n) => {
                                buf.truncate(n);
                                Ok(Bytes::from(buf))
                            }
                            Err(e) => Err(e),
                        };
                        (body, got)
                    }));
                }
                Feed::Reading(mut job) => {
                    let Poll::Ready(done) = Pin::new(&mut job).poll(cx) else {
                        self.feed = Feed::Reading(job);
                        return Poll::Pending;
                    };
                    return Poll::Ready(Some(match done {
                        Ok((body, Ok(b))) => {
                            self.left -= b.len() as u64;
                            self.feed = Feed::Idle(body);
                            Ok(Frame::data(b))
                        }
                        Ok((_, Err(e))) => Err(e),
                        Err(e) => Err(io::Error::other(e)),
                    }));
                }
            }
        }
    }
    fn is_end_stream(&self) -> bool {
        self.left == 0
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.left)
    }
}

/// Fails a write that makes no progress for `limit`, so a client that stopped reading can't hold
/// its connection open forever.
pub(crate) struct Stalls<T> {
    io: T,
    limit: Duration,
    timer: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl<T> Stalls<T> {
    pub(crate) fn new(io: T, limit: Duration) -> Stalls<T> {
        Stalls {
            io,
            limit,
            timer: None,
        }
    }
    fn watch<R>(&mut self, cx: &mut Context<'_>, got: Poll<io::Result<R>>) -> Poll<io::Result<R>> {
        if got.is_ready() {
            self.timer = None;
            return got;
        }
        let limit = self.limit;
        let timer = self
            .timer
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(limit)));
        match timer.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the client stopped reading",
            ))),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for Stalls<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Stalls<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let got = Pin::new(&mut this.io).poll_write(cx, buf);
        this.watch(cx, got)
    }
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let got = Pin::new(&mut this.io).poll_write_vectored(cx, bufs);
        this.watch(cx, got)
    }
    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let got = Pin::new(&mut this.io).poll_flush(cx);
        this.watch(cx, got)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{start_with, Config, Handle};
    use std::io::Write;
    use std::net::TcpStream;
    use std::time::Instant;

    /// A server on a fresh folder; `big` adds a 256 MB file to stream. Returns the folder to remove.
    fn server(tag: &str, limits: Limits, big: bool) -> (Handle, std::path::PathBuf) {
        let base =
            std::env::temp_dir().join(format!("flick-server-limits-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let media = base.join("Movies");
        std::fs::create_dir_all(&media).unwrap();
        if big {
            // Sparse where the filesystem allows, so it costs no disk.
            std::fs::File::create(media.join("big.mp4"))
                .unwrap()
                .set_len(256 << 20)
                .unwrap();
        }
        let cfg = Config {
            media: vec![media],
            port: 0,
            name: "Test box".into(),
            lan: false,
            config_dir: base.join("cfg"),
            web: None,
        };
        (start_with(cfg, limits).unwrap(), base)
    }

    /// Reads until the server closes the connection, or fails after `wait`.
    fn read_until_closed(s: &mut TcpStream, wait: Duration) -> Vec<u8> {
        s.set_read_timeout(Some(wait)).unwrap();
        let (mut got, mut buf) = (Vec::new(), vec![0u8; 1 << 16]);
        loop {
            match s.read(&mut buf) {
                Ok(0) => return got,
                Ok(n) => got.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::ConnectionReset => return got,
                Err(e) => panic!("the connection stayed open: {e}"),
            }
        }
    }

    #[test]
    fn a_client_that_sends_no_request_in_time_is_dropped() {
        let limits = Limits {
            header_read: Duration::from_millis(300),
            ..LIMITS
        };
        let (h, base) = server("headers", limits, false);
        let port = h.port();
        let t = Instant::now();
        // Half a request, nothing at all, and an idle keep-alive connection after one answer.
        let mut half = TcpStream::connect(("127.0.0.1", port)).unwrap();
        half.write_all(b"GET /api/info HTTP/1.1\r\nHost: x\r\n")
            .unwrap();
        let mut silent = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut kept = TcpStream::connect(("127.0.0.1", port)).unwrap();
        kept.write_all(b"GET /api/info HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        assert!(!read_until_closed(&mut half, Duration::from_secs(5)).starts_with(b"HTTP/1.1 200"));
        assert!(read_until_closed(&mut silent, Duration::from_secs(5)).is_empty());
        assert!(read_until_closed(&mut kept, Duration::from_secs(5)).starts_with(b"HTTP/1.1 200"));
        assert!(
            t.elapsed() < Duration::from_secs(3),
            "took {:?}",
            t.elapsed()
        );
        h.stop();
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_stream_the_client_stopped_reading_is_dropped() {
        let limits = Limits {
            write_stall: Duration::from_millis(300),
            ..LIMITS
        };
        let (h, base) = server("stall", limits, true);
        let id = crate::index::item_id("Movies", "big.mp4");
        let mut s = TcpStream::connect(("127.0.0.1", h.port())).unwrap();
        write!(
            s,
            "GET /media/{id} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {}\r\n\r\n",
            h.token()
        )
        .unwrap();
        let mut first = [0u8; 4096];
        s.read_exact(&mut first).unwrap();
        assert!(first.starts_with(b"HTTP/1.1 200"));
        std::thread::sleep(Duration::from_millis(1500));
        // Only what was already in the socket buffers arrives; the rest of the file never does.
        let got = read_until_closed(&mut s, Duration::from_secs(20));
        assert!(got.len() < (64 << 20), "{} bytes arrived", got.len());
        h.stop();
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn many_idle_connections_do_not_keep_a_request_from_being_answered() {
        let (h, base) = server("idle", LIMITS, false);
        let port = h.port();
        let _idle: Vec<_> = (0..200)
            .map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap())
            .collect();
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"GET /api/info HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .unwrap();
        assert!(read_until_closed(&mut s, Duration::from_secs(5)).starts_with(b"HTTP/1.1 200"));
        h.stop();
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn connections_past_the_cap_are_closed() {
        let limits = Limits {
            connections: 2,
            ..LIMITS
        };
        let (h, base) = server("cap", limits, false);
        let port = h.port();
        let first = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _second = TcpStream::connect(("127.0.0.1", port)).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let info = |s: &mut TcpStream| {
            let _ = s.write_all(b"GET /api/info HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
            read_until_closed(s, Duration::from_secs(5))
        };
        let mut third = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert!(
            info(&mut third).is_empty(),
            "a third connection was answered"
        );
        // A freed slot takes a new connection.
        drop(first);
        std::thread::sleep(Duration::from_millis(200));
        let mut fourth = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert!(info(&mut fourth).starts_with(b"HTTP/1.1 200"));
        h.stop();
        std::fs::remove_dir_all(base).unwrap();
    }
}
