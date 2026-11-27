// Fetches for source plugins, with no CORS limit, only to the hosts in the plugin's installed manifest.
// The web side registers those hosts from its installed record (plugin_hosts); plugin_fetch takes only
// the plugin id and the request, so a plugin can never widen its own allowlist.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Url;

const MAX_BODY: u64 = 16 * 1024 * 1024;
const MAX_HOPS: usize = 5;

#[derive(Default)]
pub struct PluginHosts(Mutex<HashMap<String, Vec<String>>>);

#[derive(serde::Serialize, Debug)]
pub struct FetchReply {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

/// An address only an explicit entry may reach: loopback, private, shared (CGNAT, Tailscale), link-local,
/// multicast and unspecified. IPv4 inside IPv6 (mapped, compatible, NAT64) is judged as the IPv4 it carries.
fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            let tail = std::net::Ipv4Addr::new(
                (s[6] >> 8) as u8,
                s[6] as u8,
                (s[7] >> 8) as u8,
                s[7] as u8,
            );
            if let Some(m) = v.to_ipv4_mapped() {
                return is_private_ip(IpAddr::V4(m));
            }
            if (s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4])
                || (s[..6] == [0; 6] && !v.is_loopback() && !v.is_unspecified())
            {
                return is_private_ip(IpAddr::V4(tail));
            }
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

/// A name only an explicit entry may reach: a private address, `localhost`, `.local`.
pub(crate) fn is_private(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = h.parse::<IpAddr>() {
        return is_private_ip(ip);
    }
    h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local")
}

/// True when the URL's host is listed by name or wildcard, not only through `*`.
fn listed(patterns: &[String], host: &str) -> bool {
    patterns.iter().any(|p| {
        let p = p.to_ascii_lowercase();
        p != "*"
            && (host == p
                || p.strip_prefix("*.")
                    .is_some_and(|b| host.ends_with(&format!(".{b}"))))
    })
}

const INSIDE: &str = "points inside this network";

type Lookup = fn(&str, u16) -> std::io::Result<Vec<std::net::SocketAddr>>;

fn system_lookup(host: &str, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
    use std::net::ToSocketAddrs;
    (host, port).to_socket_addrs().map(|a| a.collect())
}

/// Resolves for the connection itself, so the addresses checked are the ones connected to (no second
/// lookup a rebinding name could answer differently). With `public_only`, any private address refuses.
#[derive(Debug)]
struct Guarded {
    public_only: bool,
    lookup: Lookup,
}

impl ureq::unversioned::resolver::Resolver for Guarded {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        _config: &ureq::config::Config,
        _timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        let host = uri
            .host()
            .ok_or(ureq::Error::HostNotFound)?
            .trim_start_matches('[')
            .trim_end_matches(']');
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("https") {
                443
            } else {
                80
            });
        let addrs = (self.lookup)(host, port)?;
        if self.public_only && addrs.iter().any(|a| is_private_ip(a.ip())) {
            return Err(ureq::Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                INSIDE,
            )));
        }
        let mut out = self.empty();
        for a in addrs.into_iter().take(16) {
            out.push(a);
        }
        if out.is_empty() {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(out)
    }
}

/// Does `url` match one of the patterns: `*` (any public host), `*.example.com` (its subdomains), or an exact host.
pub fn host_allowed(patterns: &[String], url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    patterns.iter().any(|p| {
        let p = p.to_ascii_lowercase();
        if p == "*" {
            !is_private(&host)
        } else if let Some(base) = p.strip_prefix("*.") {
            host.ends_with(&format!(".{base}"))
        } else {
            host == p
        }
    })
}

impl PluginHosts {
    /// The hosts registered for one plugin; empty when it has none.
    pub fn hosts_of(&self, id: &str) -> Vec<String> {
        self.0.lock().unwrap().get(id).cloned().unwrap_or_default()
    }
}

#[tauri::command]
pub fn plugin_hosts(state: tauri::State<'_, PluginHosts>, id: String, hosts: Vec<String>) {
    let mut map = state.0.lock().unwrap();
    if hosts.is_empty() {
        map.remove(&id);
    } else {
        map.insert(id, hosts);
    }
}

#[tauri::command]
pub async fn plugin_fetch(
    state: tauri::State<'_, PluginHosts>,
    id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<FetchReply, String> {
    let allowed = state
        .0
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || fetch(&allowed, &url, &method, &headers, body))
        .await
        .map_err(|e| e.to_string())?
}

fn agent(public_only: bool, lookup: Lookup) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        // Redirects are followed below, so each hop is checked against the allowlist.
        .max_redirects(0)
        .max_redirects_will_error(false)
        .build();
    ureq::Agent::with_parts(
        config,
        ureq::unversioned::transport::DefaultConnector::new(),
        Guarded {
            public_only,
            lookup,
        },
    )
}

/// A redirect from https to anything else would send the plugin's headers (a service's key) in the clear.
fn downgrades(from: &Url, to: &Url) -> bool {
    from.scheme() == "https" && to.scheme() != "https"
}

pub fn fetch(
    allowed: &[String],
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<String>,
) -> Result<FetchReply, String> {
    fetch_with(allowed, url, method, headers, body, system_lookup)
}

fn fetch_with(
    allowed: &[String],
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<String>,
    lookup: Lookup,
) -> Result<FetchReply, String> {
    let mut target = Url::parse(url).map_err(|_| format!("Not a web address: {url}"))?;
    let mut method = method.to_ascii_uppercase();
    let mut body = body;
    if !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(&method.as_str()) {
        return Err(format!("Plugins cannot send {method} requests."));
    }
    for _ in 0..=MAX_HOPS {
        if !host_allowed(allowed, &target) {
            return Err(format!(
                "This plugin may not reach {}. Its hosts list does not include it.",
                target.host_str().unwrap_or("that address")
            ));
        }
        let host = target.host_str().unwrap_or("").to_ascii_lowercase();
        // Reached only through `*`: the connection's own lookup refuses private addresses.
        let agent = agent(!listed(allowed, &host), lookup);
        let mut req = ureq::http::Request::builder()
            .method(method.as_str())
            .uri(target.as_str());
        for (k, v) in headers {
            let lk = k.to_ascii_lowercase();
            // The plugin cannot pick the host or reuse the user's browser cookies.
            if lk == "host" || lk == "cookie" || lk.starts_with("proxy-") {
                continue;
            }
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = match &body {
            Some(b) => agent.run(
                req.body(b.clone().into_bytes())
                    .map_err(|e| e.to_string())?,
            ),
            None => agent.run(req.body(()).map_err(|e| e.to_string())?),
        };
        let mut resp = resp.map_err(|e| {
            if e.to_string().contains(INSIDE) {
                format!("{host} {INSIDE}. List it by name in hosts to reach it.")
            } else {
                format!("Could not reach {host}: {e}")
            }
        })?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                let next = target.join(loc).map_err(|e| e.to_string())?;
                if downgrades(&target, &next) {
                    return Err("A plugin request may not move from https to http.".into());
                }
                target = next;
                if status == 303 || ((status == 301 || status == 302) && method == "POST") {
                    method = "GET".into();
                    body = None;
                }
                continue;
            }
        }
        let mut out = HashMap::new();
        for (k, v) in resp.headers() {
            if let Ok(v) = v.to_str() {
                out.insert(k.as_str().to_string(), v.to_string());
            }
        }
        let text = resp
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_string()
            .unwrap_or_default();
        return Ok(FetchReply {
            status,
            headers: out,
            body: text,
        });
    }
    Err("Too many redirects.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(patterns: &[&str], url: &str) -> bool {
        let p: Vec<String> = patterns.iter().map(|s| s.to_string()).collect();
        host_allowed(&p, &Url::parse(url).unwrap())
    }

    #[test]
    fn matches_exact_wildcard_and_any_public_host() {
        assert!(ok(&["archive.org"], "https://archive.org/x"));
        assert!(!ok(&["archive.org"], "https://evil.com/x"));
        assert!(!ok(&["archive.org"], "https://archive.org.evil.com/x"));
        assert!(!ok(&["archive.org"], "https://notarchive.org/x"));
        assert!(ok(&["*.archive.org"], "https://ia800.archive.org/x"));
        assert!(!ok(&["*.archive.org"], "https://notarchive.org/x"));
        assert!(ok(&["*"], "https://v3-cinemeta.strem.io/manifest.json"));
        assert!(!ok(&["archive.org"], "file:///etc/passwd"));
        assert!(!ok(&["*"], "ftp://example.com/"));
    }

    #[test]
    fn any_host_never_reaches_this_machine_or_the_lan() {
        for u in [
            "http://127.0.0.1:11470/settings",
            "http://localhost:8080/",
            "http://192.168.1.1/",
            "http://10.0.0.2/",
            "http://[::1]/",
            "http://nas.local/",
            "http://169.254.169.254/latest/meta-data",
        ] {
            assert!(!ok(&["*"], u), "{u} should need an explicit entry");
        }
        assert!(ok(&["127.0.0.1"], "http://127.0.0.1:11470/settings"));
    }

    #[test]
    fn ipv4_inside_ipv6_and_shared_ranges_count_as_private() {
        for u in [
            "http://[::ffff:127.0.0.1]:11470/settings",
            "http://[::ffff:192.168.1.1]/",
            "http://[64:ff9b::a00:2]/",
            "http://[::7f00:1]/",
            "http://100.100.100.100/",
            "http://0.0.0.0/",
        ] {
            assert!(!ok(&["*"], u), "{u} should need an explicit entry");
        }
        assert!(ok(&["*"], "http://[::ffff:8.8.8.8]/"));
        assert!(ok(&["*"], "http://8.8.8.8/"));
    }

    /// One HTTP reply on loopback, for names the tests resolve there.
    fn one_reply() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                use std::io::{Read, Write};
                let mut b = [0u8; 2048];
                let _ = c.read(&mut b);
                let _ = c.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
            }
        });
        port
    }

    fn to_loopback(_: &str, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
        Ok(vec![([127, 0, 0, 1], port).into()])
    }

    fn to_mapped_loopback(_: &str, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
        Ok(vec![(
            "::ffff:127.0.0.1".parse::<std::net::Ipv6Addr>().unwrap(),
            port,
        )
            .into()])
    }

    #[test]
    fn a_public_name_that_resolves_inside_is_refused_at_connect() {
        let h = HashMap::new();
        let port = one_reply();
        let url = format!("http://rebind.example:{port}/");
        for lookup in [to_loopback as Lookup, to_mapped_loopback] {
            let err = fetch_with(&["*".into()], &url, "GET", &h, None, lookup).unwrap_err();
            assert!(err.contains("points inside this network"), "{err}");
        }
        // Listed by name, the same address is allowed.
        let r = fetch_with(
            &["rebind.example".into()],
            &url,
            "GET",
            &h,
            None,
            to_loopback,
        )
        .unwrap();
        assert_eq!((r.status, r.body.as_str()), (200, "ok"));
    }

    #[test]
    fn a_redirect_never_leaves_https() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(downgrades(&u("https://api.torbox.app/a"), &u("http://api.torbox.app/b")));
        assert!(!downgrades(&u("https://api.torbox.app/a"), &u("https://x.tb-cdn.st/b")));
        assert!(!downgrades(&u("http://192.168.1.2/a"), &u("http://192.168.1.2/b")));
    }

    #[test]
    fn fetch_refuses_a_host_not_registered_for_the_plugin() {
        let err = fetch(
            &["archive.org".into()],
            "https://example.com/",
            "GET",
            &HashMap::new(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("may not reach example.com"), "{err}");
        // An unregistered plugin has an empty list and reaches nothing.
        assert!(fetch(&[], "https://archive.org/", "GET", &HashMap::new(), None).is_err());
    }

    #[test]
    fn the_registry_holds_hosts_per_plugin() {
        let state = PluginHosts::default();
        state
            .0
            .lock()
            .unwrap()
            .insert("org.a".into(), vec!["a.example".into()]);
        let a = state
            .0
            .lock()
            .unwrap()
            .get("org.b")
            .cloned()
            .unwrap_or_default();
        assert!(fetch(&a, "https://a.example/", "GET", &HashMap::new(), None).is_err());
    }
}
