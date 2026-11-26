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

/// A name only an explicit entry may reach: loopback, private and link-local addresses, `localhost`, `.local`.
fn is_private(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = h.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v) => {
                v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified()
            }
            IpAddr::V6(v) => {
                v.is_loopback()
                    || v.is_unspecified()
                    || (v.segments()[0] & 0xfe00) == 0xfc00
                    || (v.segments()[0] & 0xffc0) == 0xfe80
            }
        };
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

/// `*` reaches public hosts only: a public name that resolves to a private address is refused too.
fn resolves_private(url: &Url) -> bool {
    use std::net::ToSocketAddrs;
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return true;
    };
    match (host.trim_start_matches('[').trim_end_matches(']'), port).to_socket_addrs() {
        Ok(addrs) => addrs.into_iter().any(|a| is_private(&a.ip().to_string())),
        Err(_) => false,
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

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        // Redirects are followed below, so each hop is checked against the allowlist.
        .max_redirects(0)
        .max_redirects_will_error(false)
        .build()
        .into()
}

pub fn fetch(
    allowed: &[String],
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<String>,
) -> Result<FetchReply, String> {
    let mut target = Url::parse(url).map_err(|_| format!("Not a web address: {url}"))?;
    let mut method = method.to_ascii_uppercase();
    let mut body = body;
    if !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(&method.as_str()) {
        return Err(format!("Plugins cannot send {method} requests."));
    }
    let agent = agent();
    for _ in 0..=MAX_HOPS {
        if !host_allowed(allowed, &target) {
            return Err(format!(
                "This plugin may not reach {}. Its hosts list does not include it.",
                target.host_str().unwrap_or("that address")
            ));
        }
        let host = target.host_str().unwrap_or("").to_ascii_lowercase();
        if !listed(allowed, &host) && resolves_private(&target) {
            return Err(format!(
                "{host} points inside this network. List it by name in hosts to reach it."
            ));
        }
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
        let mut resp =
            resp.map_err(|e| format!("Could not reach {}: {e}", target.host_str().unwrap_or("")))?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                target = target.join(loc).map_err(|e| e.to_string())?;
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
