//! The HTTP transport: hyper on a small tokio runtime of its own, carrying each request to `answer`.
use crate::{answer, Reply, Req, State, Verb};
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use hyper::header::{AUTHORIZATION, CONTENT_LENGTH, RANGE};
use hyper::{body::Incoming, service::service_fn, Method, Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::io::{self, Read};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{ready, Context, Poll};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};

/// A client must send its request headers within this long.
const HEADER_READ: Duration = Duration::from_secs(30);
const CHUNK: usize = 64 * 1024;

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
        .thread_name("flick-server")
        .enable_all()
        .build()?;
    let listener = {
        let _in = rt.enter();
        TcpListener::from_std(listener)?
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

/// A body read from a blocking reader on the blocking pool, a chunk or two ahead of the client.
pub(crate) struct Stream {
    rx: Option<mpsc::Receiver<io::Result<Bytes>>>,
    left: u64,
}

impl Stream {
    fn empty() -> Stream {
        Stream { rx: None, left: 0 }
    }
    fn read(mut body: Box<dyn Read + Send>, len: u64) -> Stream {
        let (tx, rx) = mpsc::channel(2);
        tokio::task::spawn_blocking(move || {
            let mut left = len;
            while left > 0 {
                let mut buf = vec![0; CHUNK.min(left as usize)];
                let chunk = match body.read(&mut buf) {
                    Ok(0) => Err(io::ErrorKind::UnexpectedEof.into()),
                    Ok(n) => {
                        buf.truncate(n);
                        left -= n as u64;
                        Ok(Bytes::from(buf))
                    }
                    Err(e) => Err(e),
                };
                let failed = chunk.is_err();
                // A closed channel means the connection is gone.
                if tx.blocking_send(chunk).is_err() || failed {
                    return;
                }
            }
        });
        Stream {
            rx: Some(rx),
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
        let Some(rx) = self.rx.as_mut() else {
            return Poll::Ready(None);
        };
        Poll::Ready(match ready!(rx.poll_recv(cx)) {
            Some(Ok(b)) => {
                self.left -= b.len() as u64;
                Some(Ok(Frame::data(b)))
            }
            Some(Err(e)) => Some(Err(e)),
            None => None,
        })
    }
    fn is_end_stream(&self) -> bool {
        self.left == 0
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.left)
    }
}
