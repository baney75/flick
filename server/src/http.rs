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
use tokio::net::TcpListener;
use tokio::sync::watch;

/// A client must send its request headers within this long.
const HEADER_READ: Duration = Duration::from_secs(30);
const CHUNK: usize = 64 * 1024;
/// Threads for handlers and file reads. A paused stream holds none of them.
const BLOCKING_THREADS: usize = 64;

pub(crate) struct Transport {
    rt: Option<tokio::runtime::Runtime>,
    stop: watch::Sender<bool>,
    closed: std::sync::mpsc::Receiver<()>,
}

/// Serves `listener` until `stop`.
pub(crate) fn listen(listener: std::net::TcpListener, st: Arc<State>) -> io::Result<Transport> {
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
    rt.spawn(accept(listener, st, stopped, closed_tx));
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
    mut stopped: watch::Receiver<bool>,
    closed: std::sync::mpsc::Sender<()>,
) {
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
        let (st, mut stopped) = (st.clone(), stopped.clone());
        tokio::spawn(async move {
            let _ = stream.set_nodelay(true);
            let io = TokioIo::new(stream);
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                // Header names as tiny_http wrote them, so answers read the same as before.
                .title_case_headers(true)
                .header_read_timeout(HEADER_READ)
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
